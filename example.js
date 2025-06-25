'use strict'

const aedes = require('aedes')
const { createServer } = require('net')
const persistence = require('./index')

// MySQL persistence configuration
const mysqlPersistence = persistence({
  host: process.env.MYSQL_HOST || 'localhost',
  port: process.env.MYSQL_PORT || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'aedes_example',
  
  // TTL configuration for automatic cleanup
  ttl: {
    packets: {
      incoming: 300,    // 5 minutes for QoS 2 incoming packets
      outgoing: 600,    // 10 minutes for outgoing packets
      will: 3600,       // 1 hour for will messages
      retained: -1      // Never expire retained messages
    },
    subscriptions: 7200 // 2 hours for subscriptions
  }
})

// Create Aedes broker with MySQL persistence
const broker = aedes({
  id: 'AEDES_MYSQL_BROKER',
  persistence: mysqlPersistence
})

const port = process.env.PORT || 1883
const server = createServer(broker.handle)

// Event handlers
broker.on('client', function (client) {
  console.log('Client connected:', client.id)
})

broker.on('clientDisconnect', function (client) {
  console.log('Client disconnected:', client.id)
})

broker.on('subscribe', function (subscriptions, client) {
  console.log('Client', client.id, 'subscribed to:', subscriptions.map(s => s.topic).join(', '))
})

broker.on('unsubscribe', function (subscriptions, client) {
  console.log('Client', client.id, 'unsubscribed from:', subscriptions.join(', '))
})

broker.on('publish', function (packet, client) {
  if (client) {
    console.log('Message published by', client.id, 'to topic:', packet.topic)
  } else {
    console.log('Message published to topic:', packet.topic)
  }
})

broker.on('clientError', function (client, err) {
  console.error('Client error for', client.id, ':', err.message)
})

broker.on('connectionError', function (client, err) {
  console.error('Connection error for', client ? client.id : 'unknown', ':', err.message)
})

// Start server
server.listen(port, function () {
  console.log('Aedes MQTT broker with MySQL persistence listening on port', port)
  console.log('MySQL configuration:')
  console.log('  Host:', mysqlPersistence.connectionConfig.host)
  console.log('  Port:', mysqlPersistence.connectionConfig.port)
  console.log('  Database:', mysqlPersistence.connectionConfig.database)
  console.log('  User:', mysqlPersistence.connectionConfig.user)
  console.log('')
  console.log('Try connecting with:')
  console.log('  mosquitto_pub -h localhost -p', port, '-t "test/topic" -m "Hello MySQL!"')
  console.log('  mosquitto_sub -h localhost -p', port, '-t "test/+"')
})

// Graceful shutdown
process.on('SIGINT', function () {
  console.log('\nShutting down gracefully...')
  
  server.close(function () {
    console.log('Server closed')
    
    broker.close(function () {
      console.log('Broker closed')
      
      mysqlPersistence.destroy(function (err) {
        if (err) {
          console.error('Error closing persistence:', err)
          process.exit(1)
        }
        console.log('Persistence closed')
        process.exit(0)
      })
    })
  })
})

// Handle uncaught exceptions
process.on('uncaughtException', function (err) {
  console.error('Uncaught exception:', err)
  process.exit(1)
})

process.on('unhandledRejection', function (reason, promise) {
  console.error('Unhandled rejection at:', promise, 'reason:', reason)
  process.exit(1)
})