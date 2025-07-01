'use strict'

const mysql = require('mysql2/promise')
const { Readable } = require('stream')

function AedesPersistenceMySQL (opts) {
  if (!(this instanceof AedesPersistenceMySQL)) {
    return new AedesPersistenceMySQL(opts)
  }

  opts = opts || {}
  this.options = opts
  
  // MySQL connection configuration
  this.connectionConfig = {
    host: opts.host || 'localhost',
    port: opts.port || 3306,
    user: opts.user || 'root',
    password: opts.password || '',
    database: opts.database || 'aedes',
    charset: 'utf8mb4',
    timezone: '+00:00'
  }

  // TTL settings
  this.ttl = opts.ttl || {}
  if (typeof this.ttl.packets === 'number') {
    this.ttl.packets = {
      incoming: this.ttl.packets,
      outgoing: this.ttl.packets,
      retained: this.ttl.packets,
      will: this.ttl.packets
    }
  }
  this.ttl.packets = this.ttl.packets || {}
  this.ttl.subscriptions = this.ttl.subscriptions || null

  this.pool = null
  this._ready = false
  this._closed = false

  this._setup()
}

AedesPersistenceMySQL.prototype._setup = async function () {
  try {
    // Create connection pool
    this.pool = mysql.createPool({
      ...this.connectionConfig,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    })

    // Create tables if they don't exist
    await this._createTables()
    this._ready = true
  } catch (err) {
    console.error('Failed to setup MySQL persistence:', err)
    throw err
  }
}

AedesPersistenceMySQL.prototype._createTables = async function () {
  const connection = await this.pool.getConnection()
  
  try {
    // Subscriptions table
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS aedes_subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        client_id VARCHAR(255) NOT NULL,
        topic VARCHAR(512) NOT NULL,
        qos TINYINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_client_id (client_id),
        INDEX idx_topic (topic),
        UNIQUE KEY unique_subscription (client_id, topic)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)

    // Retained messages table
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS aedes_retained (
        id INT AUTO_INCREMENT PRIMARY KEY,
        topic VARCHAR(512) NOT NULL UNIQUE,
        payload LONGBLOB,
        qos TINYINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_topic (topic)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)

    // Outgoing packets table
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS aedes_outgoing (
        id INT AUTO_INCREMENT PRIMARY KEY,
        client_id VARCHAR(255) NOT NULL,
        message_id INT,
        topic VARCHAR(512) NOT NULL,
        payload LONGBLOB,
        qos TINYINT NOT NULL,
        retain_flag BOOLEAN DEFAULT FALSE,
        dup_flag BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_client_id (client_id),
        INDEX idx_message_id (client_id, message_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)

    // Incoming packets table (for QoS 2)
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS aedes_incoming (
        id INT AUTO_INCREMENT PRIMARY KEY,
        client_id VARCHAR(255) NOT NULL,
        message_id INT NOT NULL,
        topic VARCHAR(512) NOT NULL,
        payload LONGBLOB,
        qos TINYINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_incoming (client_id, message_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)

    // Will messages table
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS aedes_will (
        id INT AUTO_INCREMENT PRIMARY KEY,
        client_id VARCHAR(255) NOT NULL UNIQUE,
        topic VARCHAR(512) NOT NULL,
        payload LONGBLOB,
        qos TINYINT NOT NULL,
        retain_flag BOOLEAN DEFAULT FALSE,
        broker_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_client_id (client_id),
        INDEX idx_broker_id (broker_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)

    // Add TTL cleanup if configured
    if (this.ttl.subscriptions && this.ttl.subscriptions > 0) {
      await connection.execute(`
        CREATE EVENT IF NOT EXISTS aedes_cleanup_subscriptions
        ON SCHEDULE EVERY 1 HOUR
        DO DELETE FROM subscriptions WHERE created_at < DATE_SUB(NOW(), INTERVAL ${this.ttl.subscriptions} SECOND)
      `)
    }

  } finally {
    connection.release()
  }
}

// Store a retained message
AedesPersistenceMySQL.prototype.storeRetained = function (packet, cb) {
  if (!this._ready) {
    return cb(new Error('MySQL persistence not ready'))
  }

  const query = `
    INSERT INTO aedes_retained (topic, payload, qos) 
    VALUES (?, ?, ?) 
    ON DUPLICATE KEY UPDATE payload = VALUES(payload), qos = VALUES(qos), created_at = CURRENT_TIMESTAMP
  `
  
  this.pool.execute(query, [packet.topic, packet.payload, packet.qos])
    .then(() => cb())
    .catch(cb)
}

// Create retained stream for pattern matching
AedesPersistenceMySQL.prototype.createRetainedStreamCombi = function (patterns) {
  const stream = new Readable({ objectMode: true })
  stream._read = () => {}

  if (!this._ready) {
    stream.destroy(new Error('MySQL persistence not ready'))
    return stream
  }

  // Convert MQTT patterns to SQL LIKE patterns
  const conditions = patterns.map(pattern => {
    const sqlPattern = pattern
      .replace(/\+/g, '[^/]+')  // + matches single level
      .replace(/#/g, '.*')      // # matches multi level
    return `topic REGEXP ?`
  })

  const query = `SELECT topic, payload, qos FROM aedes_retained WHERE ${conditions.join(' OR ')}`
  const params = patterns.map(pattern => 
    '^' + pattern.replace(/\+/g, '[^/]+').replace(/#/g, '.*') + '$'
  )

  this.pool.execute(query, params)
    .then(([rows]) => {
      rows.forEach(row => {
        stream.push({
          topic: row.topic,
          payload: row.payload,
          qos: row.qos
        })
      })
      stream.push(null)
    })
    .catch(err => stream.destroy(err))

  return stream
}

// Add subscriptions for a client
AedesPersistenceMySQL.prototype.addSubscriptions = function (client, subscriptions, cb) {
  if (!this._ready) {
    return cb(new Error('MySQL persistence not ready'))
  }

  const values = subscriptions.map(sub => [client.id, sub.topic, sub.qos])
  const query = `
    INSERT INTO aedes_subscriptions (client_id, topic, qos) 
    VALUES ? 
    ON DUPLICATE KEY UPDATE qos = VALUES(qos), created_at = CURRENT_TIMESTAMP
  `

  this.pool.execute(query, [values])
    .then(() => cb(null, client))
    .catch(cb)
}

// Remove subscriptions for a client
AedesPersistenceMySQL.prototype.removeSubscriptions = function (client, topics, cb) {
  if (!this._ready) {
    return cb(new Error('MySQL persistence not ready'))
  }

  if (topics.length === 0) {
    return cb(null, client)
  }

  // Create placeholders for IN clause
  const placeholders = topics.map(() => '?').join(',')
  const query = `DELETE FROM aedes_subscriptions WHERE client_id = ? AND topic IN (${placeholders})`
  
  this.pool.execute(query, [client.id, ...topics])
    .then(() => cb(null, client))
    .catch(cb)
}

// Get subscriptions for a client
AedesPersistenceMySQL.prototype.subscriptionsByClient = function (client, cb) {
  if (!this._ready) {
    return cb(new Error('MySQL persistence not ready'))
  }

  const query = 'SELECT topic, qos FROM aedes_subscriptions WHERE client_id = ?'
  
  this.pool.execute(query, [client.id])
    .then(([rows]) => {
      const subscriptions = rows.map(row => ({
        topic: row.topic,
        qos: row.qos
      }))
      cb(null, subscriptions, client)
    })
    .catch(cb)
}

// Count offline subscriptions and clients
AedesPersistenceMySQL.prototype.countOffline = function (cb) {
  if (!this._ready) {
    return cb(new Error('MySQL persistence not ready'))
  }

  const queries = [
    'SELECT COUNT(*) as count FROM aedes_subscriptions',
    'SELECT COUNT(DISTINCT client_id) as count FROM aedes_subscriptions'
  ]

  Promise.all(queries.map(query => this.pool.execute(query)))
    .then(results => {
      const numSubscriptions = results[0][0][0].count
      const numClients = results[1][0][0].count
      cb(null, numSubscriptions, numClients)
    })
    .catch(cb)
}

// Get subscriptions by topic pattern
AedesPersistenceMySQL.prototype.subscriptionsByTopic = function (pattern, cb) {
  if (!this._ready) {
    return cb(new Error('MySQL persistence not ready'))
  }

  // Convert MQTT pattern to SQL REGEXP
  const sqlPattern = '^' + pattern
    .replace(/\+/g, '[^/]+')
    .replace(/#/g, '.*') + '$'

  const query = 'SELECT client_id, topic, qos FROM aedes_subscriptions WHERE topic REGEXP ?'
  
  this.pool.execute(query, [sqlPattern])
    .then(([rows]) => {
      const subscriptions = rows.map(row => ({
        clientId: row.client_id,
        topic: row.topic,
        qos: row.qos
      }))
      cb(null, subscriptions)
    })
    .catch(cb)
}

// Clean all subscriptions for a client
AedesPersistenceMySQL.prototype.cleanSubscriptions = function (client, cb) {
  if (!this._ready) {
    return cb(new Error('MySQL persistence not ready'))
  }

  const query = 'DELETE FROM aedes_subscriptions WHERE client_id = ?'
  
  this.pool.execute(query, [client.id])
    .then(() => cb(null, client))
    .catch(cb)
}

// Enqueue outgoing packet
AedesPersistenceMySQL.prototype.outgoingEnqueueCombi = function (subscriptions, packet, cb) {
  if (!this._ready) {
    return cb(new Error('MySQL persistence not ready'))
  }

  const values = subscriptions.map(sub => [
    sub.clientId,
    packet.messageId || null,
    packet.topic,
    packet.payload,
    packet.qos,
    packet.retain || false,
    packet.dup || false
  ])

  if (values.length === 0) {
    return cb()
  }

  const query = `
    INSERT INTO aedes_outgoing (client_id, message_id, topic, payload, qos, retain_flag, dup_flag) 
    VALUES ?
  `

  this.pool.execute(query, [values])
    .then(() => cb())
    .catch(cb)
}

// Update outgoing packet
AedesPersistenceMySQL.prototype.outgoingUpdate = function (client, packet, cb) {
  if (!this._ready) {
    return cb(new Error('MySQL persistence not ready'))
  }

  const query = `
    UPDATE aedes_outgoing 
    SET message_id = ?, dup_flag = ? 
    WHERE client_id = ? AND topic = ? AND payload = ?
  `

  this.pool.execute(query, [
    packet.messageId,
    packet.dup || false,
    client.id,
    packet.topic,
    packet.payload
  ])
    .then(() => cb())
    .catch(cb)
}

// Clear message by ID
AedesPersistenceMySQL.prototype.outgoingClearMessageId = function (client, packet, cb) {
  if (!this._ready) {
    return cb(new Error('MySQL persistence not ready'))
  }

  const query = 'DELETE FROM aedes_outgoing WHERE client_id = ? AND message_id = ?'
  
  this.pool.execute(query, [client.id, packet.messageId])
    .then(() => cb(null, packet))
    .catch(cb)
}

// Create outgoing stream for client
AedesPersistenceMySQL.prototype.outgoingStream = function (client) {
  const stream = new Readable({ objectMode: true })
  stream._read = () => {}

  if (!this._ready) {
    stream.destroy(new Error('MySQL persistence not ready'))
    return stream
  }

  const query = 'SELECT * FROM aedes_outgoing WHERE client_id = ? ORDER BY id'
  
  this.pool.execute(query, [client.id])
    .then(([rows]) => {
      rows.forEach(row => {
        stream.push({
          messageId: row.message_id,
          topic: row.topic,
          payload: row.payload,
          qos: row.qos,
          retain: row.retain_flag,
          dup: row.dup_flag
        })
      })
      stream.push(null)
    })
    .catch(err => stream.destroy(err))

  return stream
}

// Store incoming packet (QoS 2)
AedesPersistenceMySQL.prototype.incomingStorePacket = function (client, packet, cb) {
  if (!this._ready) {
    return cb(new Error('MySQL persistence not ready'))
  }

  const query = `
    INSERT INTO aedes_incoming (client_id, message_id, topic, payload, qos) 
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE topic = VALUES(topic), payload = VALUES(payload), qos = VALUES(qos)
  `

  this.pool.execute(query, [
    client.id,
    packet.messageId,
    packet.topic,
    packet.payload,
    packet.qos
  ])
    .then(() => cb(null, packet))
    .catch(cb)
}

// Get incoming packet (QoS 2)
AedesPersistenceMySQL.prototype.incomingGetPacket = function (client, packet, cb) {
  if (!this._ready) {
    return cb(new Error('MySQL persistence not ready'))
  }

  const query = 'SELECT * FROM aedes_incoming WHERE client_id = ? AND message_id = ?'
  
  this.pool.execute(query, [client.id, packet.messageId])
    .then(([rows]) => {
      if (rows.length === 0) {
        return cb(new Error('Packet not found'))
      }
      const row = rows[0]
      cb(null, {
        messageId: row.message_id,
        topic: row.topic,
        payload: row.payload,
        qos: row.qos
      })
    })
    .catch(cb)
}

// Delete incoming packet (QoS 2)
AedesPersistenceMySQL.prototype.incomingDelPacket = function (client, packet, cb) {
  if (!this._ready) {
    return cb(new Error('MySQL persistence not ready'))
  }

  const query = 'DELETE FROM aedes_incoming WHERE client_id = ? AND message_id = ?'
  
  this.pool.execute(query, [client.id, packet.messageId])
    .then(() => cb(null, packet))
    .catch(cb)
}

// Store will message
AedesPersistenceMySQL.prototype.putWill = function (client, packet, cb) {
  if (!this._ready) {
    return cb(new Error('MySQL persistence not ready'))
  }

  const query = `
    INSERT INTO aedes_will (client_id, topic, payload, qos, retain_flag, broker_id) 
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE 
      topic = VALUES(topic), 
      payload = VALUES(payload), 
      qos = VALUES(qos), 
      retain_flag = VALUES(retain_flag),
      broker_id = VALUES(broker_id),
      created_at = CURRENT_TIMESTAMP
  `

  this.pool.execute(query, [
    client.id,
    packet.topic,
    packet.payload,
    packet.qos,
    packet.retain || false,
    client.broker ? client.broker.id : null
  ])
    .then(() => cb())
    .catch(cb)
}

// Get will message
AedesPersistenceMySQL.prototype.getWill = function (client, cb) {
  if (!this._ready) {
    return cb(new Error('MySQL persistence not ready'))
  }

  const query = 'SELECT * FROM aedes_will WHERE client_id = ?'
  
  this.pool.execute(query, [client.id])
    .then(([rows]) => {
      if (rows.length === 0) {
        return cb(null, null)
      }
      const row = rows[0]
      cb(null, {
        topic: row.topic,
        payload: row.payload,
        qos: row.qos,
        retain: row.retain_flag
      })
    })
    .catch(cb)
}

// Delete will message
AedesPersistenceMySQL.prototype.delWill = function (client, cb) {
  if (!this._ready) {
    return cb(new Error('MySQL persistence not ready'))
  }

  const query = 'DELETE FROM aedes_will WHERE client_id = ?'
  
  this.pool.execute(query, [client.id])
    .then(() => cb())
    .catch(cb)
}

// Stream will messages by brokers
AedesPersistenceMySQL.prototype.streamWill = function (brokers) {
  const stream = new Readable({ objectMode: true })
  stream._read = () => {}

  if (!this._ready) {
    stream.destroy(new Error('MySQL persistence not ready'))
    return stream
  }

  const brokerIds = Object.keys(brokers)
  if (brokerIds.length === 0) {
    stream.push(null)
    return stream
  }

  // Create placeholders for IN clause
  const placeholders = brokerIds.map(() => '?').join(',')
  const query = `SELECT * FROM aedes_will WHERE broker_id IN (${placeholders})`
  
  this.pool.execute(query, brokerIds)
    .then(([rows]) => {
      rows.forEach(row => {
        stream.push({
          clientId: row.client_id,
          topic: row.topic,
          payload: row.payload,
          qos: row.qos,
          retain: row.retain_flag,
          brokerId: row.broker_id
        })
      })
      stream.push(null)
    })
    .catch(err => stream.destroy(err))

  return stream
}

// Get client list for topic
AedesPersistenceMySQL.prototype.getClientList = function (topic) {
  const stream = new Readable({ objectMode: true })
  stream._read = () => {}

  if (!this._ready) {
    stream.destroy(new Error('MySQL persistence not ready'))
    return stream
  }

  const query = 'SELECT DISTINCT client_id FROM aedes_subscriptions WHERE topic = ?'
  
  this.pool.execute(query, [topic])
    .then(([rows]) => {
      rows.forEach(row => {
        stream.push(row.client_id)
      })
      stream.push(null)
    })
    .catch(err => stream.destroy(err))

  return stream
}

// Destroy persistence
AedesPersistenceMySQL.prototype.destroy = function (cb) {
  if (this._closed) {
    return cb()
  }

  this._closed = true
  this._ready = false

  if (this.pool) {
    this.pool.end()
      .then(() => cb())
      .catch(cb)
  } else {
    cb()
  }
}

// Legacy method for backward compatibility
AedesPersistenceMySQL.prototype.createRetainedStream = function (pattern) {
  return this.createRetainedStreamCombi([pattern])
}

// Legacy method for backward compatibility
AedesPersistenceMySQL.prototype.outgoingEnqueue = function (subscription, packet, cb) {
  this.outgoingEnqueueCombi([subscription], packet, cb)
}

module.exports = AedesPersistenceMySQL