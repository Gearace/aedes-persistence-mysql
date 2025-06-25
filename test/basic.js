'use strict'

const test = require('tape')
const persistence = require('../')
const abs = require('aedes-persistence/abstract')

// Test configuration
const mysqlOpts = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: process.env.MYSQL_PORT || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'aedes_test'
}

// Clean database before each test
function clean (cb) {
  const mysql = require('mysql2/promise')
  
  mysql.createConnection(mysqlOpts)
    .then(async (connection) => {
      try {
        await connection.execute('DROP TABLE IF EXISTS subscriptions')
        await connection.execute('DROP TABLE IF EXISTS retained')
        await connection.execute('DROP TABLE IF EXISTS outgoing')
        await connection.execute('DROP TABLE IF EXISTS incoming')
        await connection.execute('DROP TABLE IF EXISTS will')
        await connection.end()
        cb()
      } catch (err) {
        await connection.end()
        cb(err)
      }
    })
    .catch(cb)
}

// Run abstract tests
abs({
  test: test,
  persistence: function build (cb) {
    clean(function (err) {
      if (err) {
        return cb(err)
      }
      
      const instance = persistence(mysqlOpts)
      
      // Wait for setup to complete
      setTimeout(() => {
        if (instance._ready) {
          cb(null, instance)
        } else {
          cb(new Error('Persistence not ready'))
        }
      }, 1000)
    })
  }
})

// Additional MySQL-specific tests
test('MySQL persistence creation', function (t) {
  t.plan(2)
  
  const instance = persistence(mysqlOpts)
  t.ok(instance, 'instance created')
  t.equal(typeof instance.storeRetained, 'function', 'has storeRetained method')
})

test('MySQL connection options', function (t) {
  t.plan(4)
  
  const instance = persistence({
    host: 'localhost',
    port: 3306,
    user: 'testuser',
    password: 'testpass',
    database: 'testdb'
  })
  
  t.equal(instance.connectionConfig.host, 'localhost', 'host set correctly')
  t.equal(instance.connectionConfig.port, 3306, 'port set correctly')
  t.equal(instance.connectionConfig.user, 'testuser', 'user set correctly')
  t.equal(instance.connectionConfig.database, 'testdb', 'database set correctly')
})

test('TTL configuration', function (t) {
  t.plan(3)
  
  const instance = persistence({
    ...mysqlOpts,
    ttl: {
      packets: 300,
      subscriptions: 600
    }
  })
  
  t.equal(instance.ttl.packets.incoming, 300, 'packets TTL set correctly')
  t.equal(instance.ttl.packets.outgoing, 300, 'packets TTL applied to all types')
  t.equal(instance.ttl.subscriptions, 600, 'subscriptions TTL set correctly')
})

test('TTL configuration with object', function (t) {
  t.plan(4)
  
  const instance = persistence({
    ...mysqlOpts,
    ttl: {
      packets: {
        incoming: 100,
        outgoing: 200,
        retained: 300,
        will: 400
      },
      subscriptions: 500
    }
  })
  
  t.equal(instance.ttl.packets.incoming, 100, 'incoming TTL set correctly')
  t.equal(instance.ttl.packets.outgoing, 200, 'outgoing TTL set correctly')
  t.equal(instance.ttl.packets.retained, 300, 'retained TTL set correctly')
  t.equal(instance.ttl.packets.will, 400, 'will TTL set correctly')
})

test('cleanup', function (t) {
  clean(function (err) {
    t.error(err, 'no error during cleanup')
    t.end()
  })
})