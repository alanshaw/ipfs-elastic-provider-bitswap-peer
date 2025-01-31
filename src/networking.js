'use strict'

const { EventEmitter } = require('events')
const lengthPrefixedMessage = require('it-length-prefixed')
const pipe = require('it-pipe')

const { logger, serializeError } = require('./logging')

class Connection extends EventEmitter {
  constructor(stream) {
    super()

    this.done = false
    this.values = []
    this.resolves = []
    this.shouldClose = false

    // Prepare for receiving
    pipe(stream.source, lengthPrefixedMessage.decode(), async source => {
      for await (const data of source) {
        /*
          This variable declaration is important
          If you use data.slice() within the nextTick you will always emit the last received packet
        */
        const payload = data.slice()
        process.nextTick(() => this.emit('data', payload))
      }
    })
      .then(() => {
        this.emit('end:receive')
      })
      .catch(error => {
        this.emit('error', error)
        this.emit('error:receive', error)
        logger.error({ error }, `Cannot receive data: ${serializeError(error)}`)
      })

    // Prepare for sending
    pipe(this, lengthPrefixedMessage.encode(), stream.sink)
      .then(() => {
        this.emit('end:send')
      })
      .catch(error => {
        this.emit('error', error)
        this.emit('error:send', error)
        logger.error({ error }, `Cannot send data: ${serializeError(error)}`)
      })
  }

  send(value) {
    if (this.shouldClose || this.done) {
      throw new Error('The stream is closed.')
    }

    const resolve = this.resolves.shift()

    if (resolve) {
      return resolve({ done: false, value })
    }

    this.values.push(value)
  }

  close() {
    /*
      Do not do anything immediately here, just wait for the next request for data.
      This way we are sure we have sent everything out.
    */

    this.shouldClose = true
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        // Marked as done, exit without processing additional values
        if (this.done) {
          return Promise.resolve({ done: true, value: undefined })
        }

        // There is a value in the queue, return it
        const value = this.values.shift()

        if (value) {
          return Promise.resolve({ done: false, value })
        }

        // If we should close, do not wait for new data but rather signal we're done
        if (this.shouldClose) {
          this.done = true

          for (const resolve of this.resolves) {
            resolve({ done: true, value: undefined })
          }

          this.resolves = []
          return Promise.resolve({ done: true, value: undefined })
        }

        // Return a new pending promise that it will be fulfilled as soon as value is available
        return new Promise(resolve => this.resolves.push(resolve))
      }
    }
  }
}

module.exports = { Connection }
