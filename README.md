# aedes-persistence-mysql

MySQL persistence for Aedes MQTT broker, inspired by [aedes-persistence-mongodb](https://github.com/moscajs/aedes-persistence-mongodb).

## Installation

```bash
npm install aedes aedes-persistence-mysql mysql2 --save
```

## Usage

```javascript
const aedes = require('aedes')
const persistence = require('aedes-persistence-mysql')

const mysqlPersistence = persistence({
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: 'your_password',
  database: 'aedes_mqtt',
  // Optional TTL settings
  ttl: {
    packets: {
      incoming: 300,    // QoS 2 incoming packets TTL
      outgoing: 600,    // Outgoing packets TTL
      will: 3600,       // Will messages TTL
      retained: -1      // Retained messages TTL (-1 = never expire)
    },
    subscriptions: 3600 // Subscriptions TTL
  }
})

const broker = aedes({
  persistence: mysqlPersistence
})

const server = require('net').createServer(broker.handle)
const port = 1883

server.listen(port, function () {
  console.log('Aedes MQTT broker listening on port', port)
})
```

## API

### aedesPersistenceMySQL([opts])

Creates a new instance of aedes-persistence-mysql.

#### Options

- **host**: MySQL server host (default: 'localhost')
- **port**: MySQL server port (default: 3306)
- **user**: MySQL username (default: 'root')
- **password**: MySQL password (default: '')
- **database**: MySQL database name (default: 'aedes')
- **ttl**: Time to live settings for automatic cleanup
  - **packets**: TTL for packet collections in seconds, or object with specific TTL for each packet type:
    - **incoming**: TTL for incoming packets (QoS 2)
    - **outgoing**: TTL for outgoing packets
    - **retained**: TTL for retained messages
    - **will**: TTL for will messages
  - **subscriptions**: TTL for subscriptions in seconds

## Database Schema

The library automatically creates the following tables:

### subscriptions
Stores client subscriptions for offline message delivery.

```sql
CREATE TABLE subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id VARCHAR(255) NOT NULL,
  topic VARCHAR(512) NOT NULL,
  qos TINYINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_client_id (client_id),
  INDEX idx_topic (topic),
  UNIQUE KEY unique_subscription (client_id, topic)
)
```

### retained
Stores retained messages.

```sql
CREATE TABLE retained (
  id INT AUTO_INCREMENT PRIMARY KEY,
  topic VARCHAR(512) NOT NULL UNIQUE,
  payload LONGBLOB,
  qos TINYINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_topic (topic)
)
```

### outgoing
Stores outgoing messages for offline clients.

```sql
CREATE TABLE outgoing (
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
)
```

### incoming
Stores incoming messages for QoS 2 flow control.

```sql
CREATE TABLE incoming (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id VARCHAR(255) NOT NULL,
  message_id INT NOT NULL,
  topic VARCHAR(512) NOT NULL,
  payload LONGBLOB,
  qos TINYINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_incoming (client_id, message_id)
)
```

### will
Stores will messages for clients.

```sql
CREATE TABLE will (
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
)
```

## Examples

### Basic Usage

```javascript
const aedes = require('aedes')
const persistence = require('aedes-persistence-mysql')

const broker = aedes({
  persistence: persistence({
    host: 'localhost',
    user: 'mqtt_user',
    password: 'mqtt_password',
    database: 'mqtt_broker'
  })
})
```

### With TTL Configuration

```javascript
const persistence = require('aedes-persistence-mysql')

const mysqlPersistence = persistence({
  host: 'localhost',
  user: 'mqtt_user',
  password: 'mqtt_password',
  database: 'mqtt_broker',
  ttl: {
    packets: {
      incoming: 300,    // 5 minutes
      outgoing: 600,    // 10 minutes
      will: 3600,       // 1 hour
      retained: -1      // Never expire
    },
    subscriptions: 7200 // 2 hours
  }
})
```

### Clustering Example

```javascript
const cluster = require('cluster')
const aedes = require('aedes')
const persistence = require('aedes-persistence-mysql')
const { createServer } = require('net')
const { cpus } = require('os')

if (cluster.isMaster) {
  const numWorkers = cpus().length
  
  for (let i = 0; i < numWorkers; i++) {
    cluster.fork()
  }
  
  cluster.on('exit', (worker) => {
    console.log(`Worker ${worker.process.pid} died`)
    cluster.fork()
  })
} else {
  const mysqlPersistence = persistence({
    host: 'localhost',
    user: 'mqtt_user',
    password: 'mqtt_password',
    database: 'mqtt_cluster'
  })
  
  const broker = aedes({
    id: 'BROKER_' + cluster.worker.id,
    persistence: mysqlPersistence
  })
  
  const server = createServer(broker.handle)
  server.listen(1883, () => {
    console.log(`Worker ${process.pid} listening on port 1883`)
  })
}
```

## Features

- ✅ Full Aedes persistence API implementation
- ✅ Automatic database schema creation
- ✅ Connection pooling for better performance
- ✅ TTL support for automatic cleanup
- ✅ MQTT topic pattern matching with wildcards (+, #)
- ✅ QoS 0, 1, and 2 message handling
- ✅ Retained message support
- ✅ Will message support
- ✅ Offline message queuing
- ✅ Multi-broker clustering support

## Requirements

- Node.js >= 12.0.0
- MySQL >= 5.7 or MariaDB >= 10.2
- Aedes >= 0.50.0

## Performance Considerations

1. **Indexes**: The library creates appropriate indexes for optimal query performance.
2. **Connection Pooling**: Uses mysql2 connection pooling to handle concurrent connections efficiently.
3. **TTL Cleanup**: Configure TTL settings to automatically clean up old data and prevent database bloat.
4. **Charset**: Uses utf8mb4 charset to support full Unicode including emojis in topic names and payloads.

## Migration from MongoDB

If you're migrating from `aedes-persistence-mongodb`, the API is compatible. Simply replace:

```javascript
// Old MongoDB persistence
const persistence = require('aedes-persistence-mongodb')
const mongoOptions = {
  url: 'mongodb://localhost:27017/aedes'
}

// New MySQL persistence
const persistence = require('aedes-persistence-mysql')
const mysqlOptions = {
  host: 'localhost',
  user: 'root',
  password: 'password',
  database: 'aedes'
}
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## See Also

- [Aedes](https://github.com/moscajs/aedes) - Barebone MQTT broker
- [aedes-persistence](https://github.com/moscajs/aedes-persistence) - Abstract persistence interface
- [aedes-persistence-mongodb](https://github.com/moscajs/aedes-persistence-mongodb) - MongoDB persistence implementation