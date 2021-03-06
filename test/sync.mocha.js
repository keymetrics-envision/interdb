/* eslint-env mocha */
'use strict'

const SegfaultHandler = require('segfault-handler')
SegfaultHandler.registerHandler('crash.log')

const assert = require('assert')
const fs = require('fs')
const crypto = require('crypto')
const InterDB = require('..')
const Plan = require('./plan')

describe('Sync', () => {
  let con1
  let con2
  let con3
  const dbPath1 = './database1'
  const dbPath2 = './database2'
  const dbPath3 = './database3'

  before(() => {
    try {
      fs.unlinkSync(dbPath1)
      fs.unlinkSync(dbPath1 + '_backup')
      fs.unlinkSync(dbPath2)
      fs.unlinkSync(dbPath2 + '_backup')
      fs.unlinkSync(dbPath3)
      fs.unlinkSync(dbPath3 + '_backup')
    } catch (e) {}

    con1 = new InterDB()
    con2 = new InterDB()
    con3 = new InterDB()
  })

  after(done => {
    const plan = new Plan(3, done)
    con1.stop(() => {
      plan.ok(true)
    })
    con2.stop(() => {
      plan.ok(true)
    })
    con3.stop(() => {
      plan.ok(true)
    })
    fs.unlinkSync(dbPath1)
    fs.unlinkSync(dbPath1 + '_backup')
    fs.unlinkSync(dbPath2)
    fs.unlinkSync(dbPath2 + '_backup')
    fs.unlinkSync(dbPath3)
    fs.unlinkSync(dbPath3 + '_backup')
  })

  it('Start con1', done => {
    con1.start({
      namespace: 'test',
      password: 'hardcoded-password',
      path: dbPath1,
      identity: {
        hostname: 'con1'
      }
    })

    con1.once('ready', () => {
      con1.db.put('key', 'value', err => {
        assert.equal(err, null)
        assert.equal(con1.db.get('key'), 'value')
        done()
      })
    })
  })

  it('con2 sync it database', done => {
    con2.start({
      namespace: 'test',
      password: 'hardcoded-password',
      path: dbPath2,
      identity: {
        hostname: 'con2'
      }
    })

    con2.once('ready', () => {
      con2.once('synced', (client) => {
        assert.equal(con2.db.get('key'), 'value')
        done()
      })
    })
  })

  it('con2 put data and con1 sync data', done => {
    con2.db.put('test', true, err => {
      assert.equal(err, null)
      con1.once('refreshed', () => {
        assert.equal(con1.db.get('test'), true)
        done()
      })
    })
  })

  it('con3 sync it database', done => {
    const plan = new Plan(3, done)
    con3.start({
      namespace: 'test',
      password: 'hardcoded-password',
      path: dbPath3,
      identity: {
        hostname: 'con3'
      }
    })

    con3.once('ready', () => {
      con3.once('synced', (client) => {
        assert.equal(con3.db.get('key'), 'value')
        assert.equal(con3.db.get('test'), true)
        plan.ok(true)
      })
    })

    con3.clients.on('peer:connected', (identity, socket) => {
      plan.ok(true)
    })
  })

  it('con3 put data and con1 and con2 sync data', done => {
    const plan = new Plan(2, done)

    con3.db.put('count', 2, err => {
      assert.equal(err, null)

      con1.once('refreshed', () => {
        assert.equal(con1.db.get('count'), 2)
        plan.ok(true)
      })
      con2.once('refreshed', () => {
        assert.equal(con2.db.get('count'), 2)
        plan.ok(true)
      })
    })
  })

  it('con 3 stop and resync', done => {
    con3.stop(() => {
      con1.db.put('bla', 'bla', () => {
        con3.start({
          namespace: 'test',
          password: 'hardcoded-password',
          path: dbPath3,
          identity: {
            hostname: 'con3'
          }
        })

        con3.once('ready', () => {
          con3.once('synced', () => {
            assert.equal(con3.db.get('bla'), 'bla')
            done()
          })
        })
      })
    })
  })

  it('con 2 stop and (con 2 + con 3) resync with 2M buffer', done => {
    const plan = new Plan(2, done)

    con2.stop(() => {
      let buffer = Buffer.alloc(2000000)
      crypto.randomFillSync(buffer)

      con1.db.put('2M', buffer, () => {
        con2.start({
          namespace: 'test',
          password: 'hardcoded-password',
          path: dbPath2,
          identity: {
            hostname: 'con2'
          }
        })

        con3.once('refreshed', () => {
          assert.equal(con3.db.getShaSum(), con1.db.getShaSum())
          assert.equal(con3.db.get('2M').data.length, 2000000)
          plan.ok(true)
        })

        con2.once('ready', () => {
          con2.once('synced', () => {
            assert.equal(con2.db.getShaSum(), con1.db.getShaSum())
            assert.equal(con2.db.get('2M').data.length, 2000000)
            plan.ok(true)
          })
        })
      })
    })
  }).timeout(10000)
})
