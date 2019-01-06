const DataStore = require('./lib/DataStore')
const request = require('request')
const sha1 = require('sha1')
const url = require('url')
const WebPageTest = require('webpagetest')

const DEFAULT_PROFILE_NAME = 'default'
const WPT_URL = 'https://www.webpagetest.org'

const Controller = function ({
  baseUrl,
  config,
  database,
  defaultProfileUrl,
  wptApiKey
}) {
  this.baseUrl = baseUrl
  this.config = config || {}
  this.dataStore = new DataStore(database)
  this.defaultProfileUrl = defaultProfileUrl
  this.wptApiKey = wptApiKey

  const wptUrl = this.config.wptUrl || WPT_URL

  this.wpt = new WebPageTest(wptUrl, wptApiKey)

  this.netlifyFunctions = {
    pingback: (event, context, callback) => {
      const {
        id,
        key,
        profile
      } = event.queryStringParameters

      return this.processResult({callback, id, key, profile})
    },
    results: (event, context, callback) => {
      const {
        from,
        profile,
        to
      } = event.queryStringParameters

      return this.getResults({callback, from, profile, to})
    },
    test: (event, context, callback) => {
      const {
        profile
      } = event.queryStringParameters

      return this.runTest({callback, profile})
    }
  }
}

Controller.prototype.buildResultsObject = function (data) {
  let result = {
    breakdownCssBytes: data.runs[1].firstView.breakdown.css.bytes,
    breakdownCssRequests: data.runs[1].firstView.breakdown.css.requests,
    breakdownFlashBytes: data.runs[1].firstView.breakdown.flash.bytes,
    breakdownFlashRequests: data.runs[1].firstView.breakdown.flash.requests,
    breakdownFontBytes: data.runs[1].firstView.breakdown.font.bytes,
    breakdownFontRequests: data.runs[1].firstView.breakdown.font.requests,
    breakdownHtmlBytes: data.runs[1].firstView.breakdown.html.bytes,
    breakdownHtmlRequests: data.runs[1].firstView.breakdown.html.requests,
    breakdownImageBytes: data.runs[1].firstView.breakdown.image.bytes,
    breakdownImageRequests: data.runs[1].firstView.breakdown.image.requests,
    breakdownJsBytes: data.runs[1].firstView.breakdown.js.bytes,
    breakdownJsRequests: data.runs[1].firstView.breakdown.js.requests,
    breakdownOtherBytes: data.runs[1].firstView.breakdown.other.bytes,
    breakdownOtherRequests: data.runs[1].firstView.breakdown.other.requests,
    breakdownVideoBytes: data.runs[1].firstView.breakdown.video.bytes,
    breakdownVideoRequests: data.runs[1].firstView.breakdown.video.requests,
    date: data.completed,
    domElements: data.average.firstView.domElements,
    domInteractive: data.average.firstView.domInteractive,
    firstPaint: data.average.firstView.firstPaint,
    fullyLoaded: data.average.firstView.fullyLoaded,
    id: data.id,
    loadTime: data.average.firstView.loadTime,
    render: data.average.firstView.render,
    SpeedIndex: data.average.firstView.SpeedIndex,
    timestamp: data.completed,
    TTFB: data.average.firstView.TTFB,
    videoFrames: data.runs[1].firstView.videoFrames.map(frame => {
      const frameUrl = url.parse(frame.image, true)

      return {
        _i: frameUrl.query.file,
        _t: frame.time,
        _vc: frame.VisuallyComplete
      }
    }),
    visualComplete: data.average.firstView.visualComplete
  }

  // Add Lighthouse score.
  const lighthouseScore = data.average.firstView['lighthouse.ProgressiveWebApp']

  result.lighthouse = typeof lighthouseScore !== 'undefined'
    ? Math.floor(lighthouseScore * 100)
    : null

  return result
}

Controller.prototype.getFunction = function (name) {
  return this.netlifyFunctions[name]
}

Controller.prototype.getResults = function ({callback, from, profile, to}) {
  if (typeof profile !== 'string') {
    return callback(null, {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Missing parameter: profile'
      })
    })
  }

  this.dataStore.get({
    profile,
    timestampFrom: from && parseInt(from),
    timestampTo: to && parseInt(to)
  }).then(results => {
    callback(null, {
      statusCode: 200,
      body: JSON.stringify(results)
    })
  }).catch(error => {
    callback(error, {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message
      })
    })
  })
}

Controller.prototype.processResult = function ({callback, id, key, profile: profileName}) {
  if (!key || !this.wptApiKey || (sha1(this.wptApiKey) !== key)) {
    return callback(null, {
      statusCode: 403,
      body: JSON.stringify({
        error: 'Invalid key'
      })
    })
  }

  if (typeof id !== 'string') {
    return callback(null, {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Missing parameter: id'
      })
    })
  }

  const {profiles = []} = this.config
  const profile = profiles[profileName]

  if (!profile && profileName !== DEFAULT_PROFILE_NAME) {
    return callback(null, {
      statusCode: 404,
      body: JSON.stringify({
        error: 'Invalid profile'
      })
    }) 
  }

  this.wpt.getTestResults(id, null, (err, wptResponse) => {
    if (err) {
      return callback(null, {
        statusCode: 500,
        body: JSON.stringify({
          error: `Could not get results for test ${id}`
        })
      })  
    }

    let result = this.buildResultsObject(wptResponse.data)

    return this.dataStore.insert({
      data: result,
      profile: profileName
    }).then(response => {
      callback(null, {
        statusCode: 200,
        body: JSON.stringify(response)
      })
    })
  })
}

Controller.prototype.runTest = function ({callback, profile: profileName}) {
  const {profiles = []} = this.config
  let profile = profiles[profileName]

  if (!profile) {
    if (
      profileName === DEFAULT_PROFILE_NAME &&
      typeof this.defaultProfileUrl === 'string' &&
      this.defaultProfileUrl.indexOf('http') === 0
    ) {
      profile = {
        parameters: {
          url: this.defaultProfileUrl
        }
      }
    } else {
      return callback(null, {
        statusCode: 404,
        body: JSON.stringify({
          error: 'Invalid profile'
        })
      })
    }
  }

  const encryptedKey = sha1(this.wptApiKey)
  const pingback = `${this.baseUrl}/.netlify/functions/pingback?key=${encryptedKey}&profile=${profileName}`

  // These parameters will be used as fallbacks, in case each of these
  // properties haven't been defined by the user.
  const defaults = {
    connectivity: 'Cable',
    lighthouse: true,
    firstViewOnly: true,
    runs: 1,
  }

  // These parameters will be used to override each of these properties,
  // even if they have been defined by the user.
  const overrides = {
    pingback,
    video: true
  }

  const parameters = Object.assign(
    {},
    defaults,
    profile.parameters,
    overrides
  )

  if (!parameters.url) {
    return callback(null, {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Missing parameter: url'
      })
    }) 
  }

  this.wpt.runTest(parameters.url, parameters, (err, response) => {
    if (err) {
      return callback(err, {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Could not run test'
        })
      }) 
    }

    callback(null, {
      statusCode: 200,
      body: JSON.stringify(response)
    }) 
  })
}

module.exports = Controller
