const DataStore = function (database) {
  this.database = database
}

DataStore.prototype.insert = function ({
  data,
  profile
}) {
  let normaliseData = Array.isArray(data) ? data : [data]

  return this.database.connect().then(() => {
    return this.database.insert({
      collection: profile,
      results: normaliseData
    })
  }).then(response => {
    this.database.disconnect()

    return null
  })
}

DataStore.prototype.get = function ({
  profile,
  timestampFrom,
  timestampTo
}) {
  return this.database.connect().then(() => {
    return this.database.get({
      collection: profile,
      timestampFrom,
      timestampTo
    })
  }).then(results => {
    this.database.disconnect()

    return results
  })
}

module.exports = DataStore
