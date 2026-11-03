import { config } from './config.js'

export function sendError(response, error, fallback = 'Something went wrong. Please try again.') {
  response.status(error.statusCode || 400).json({
    error: config.isProduction ? fallback : (error.message || fallback),
    code: error.code,
  })
}
