// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createTransport } from '@sentry/node'
import {
  MAX_ROUTE_EVENTS_PER_JOB,
  MAX_TEXT_LENGTH,
  REDACTED,
  SERVICE,
  UNVERIFIED_PRODUCTION,
  cleanText,
  initSentry,
  routeFailuresToReport,
  scrubEvent,
  sentryOptions,
  stripQuery,
} from './ssgSentry.mjs'

const DSN = 'http://public@127.0.0.1:9/1'

// What prerender writes when a page times out: the first line, then the page's own console and a
// slice of its HTML. Only the first line may leave the process.
const RENDER_FAILURE =
  'prerender failed for /en/books/dracula\n' +
  '    renderState=timeout\n' +
  '    console: [error] API error\n' +
  '    bodySnippet: <div class="reader">It was the best of times, it was the worst of times</div>'

describe('sentryOptions', () => {
  it('sentryOptions_NoDsn_ReturnsNull', () => {
    expect(sentryOptions({})).toBeNull()
    expect(sentryOptions({ SENTRY_DSN: '   ' })).toBeNull()
  })

  it('sentryOptions_Development_ReturnsNullEvenWithDsn', () => {
    expect(sentryOptions({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: 'Development' })).toBeNull()
  })

  it('sentryOptions_ProductionWithoutRelease_IsUnverified', () => {
    expect(sentryOptions({ SENTRY_DSN: DSN }).environment).toBe(UNVERIFIED_PRODUCTION)
    expect(sentryOptions({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: 'Production' }).environment).toBe(UNVERIFIED_PRODUCTION)
  })

  it('sentryOptions_ProductionWithRelease_IsProduction', () => {
    const options = sentryOptions({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: 'Production', SENTRY_RELEASE: 'abc123def456' })
    expect(options.environment).toBe('Production')
    expect(options.release).toBe('abc123def456')
  })

  it('sentryOptions_Enabled_IsErrorsOnlyAndPrivate', () => {
    const options = sentryOptions({ SENTRY_DSN: DSN })
    expect(options.sendDefaultPii).toBe(false)
    expect(options.defaultIntegrations).toBe(false)
    expect(options.tracesSampleRate).toBeUndefined()
    expect(options.initialScope.tags.service).toBe(SERVICE)
    expect(options.beforeBreadcrumb({ message: 'anything' })).toBeNull()
    expect(options.beforeSendTransaction({ type: 'transaction' })).toBeNull()
  })
})

describe('stripQuery / cleanText', () => {
  it('stripQuery_UrlWithQueryAndFragment_CutsBoth', () => {
    expect(stripQuery('http://api:8080/ssg/routes?site=x#y')).toBe('http://api:8080/ssg/routes')
    expect(stripQuery('/en/books/dracula')).toBe('/en/books/dracula')
  })

  it.each([
    ['connect ECONNREFUSED postgres://app:s3cret@db:5432/books', 's3cret'],
    ['upstream 401 for Bearer abc.def', 'abc.def'],
    ['key tsk_AbCdEf0123456789_- rejected', 'tsk_AbCdEf0123456789_-'],
    ['token tso_ZyXw9876 expired', 'tso_ZyXw9876'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln bad', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln'],
    ['GET http://api:8080/search?q=what+the+reader+typed 500', 'what+the+reader+typed'],
  ])('cleanText_Secret_IsRemoved: %s', (text, secret) => {
    expect(cleanText(text)).not.toContain(secret)
  })

  it('cleanText_OrdinaryText_IsUnchanged', () => {
    expect(cleanText('Refusing atomic swap: is the build gone? Keeping the current tree.')).toBe(
      'Refusing atomic swap: is the build gone? Keeping the current tree.',
    )
  })

  it('cleanText_LongText_IsTruncated', () => {
    expect(cleanText('x'.repeat(5000)).length).toBe(MAX_TEXT_LENGTH + 1)
  })
})

describe('scrubEvent', () => {
  it('scrubEvent_RequestAndBreadcrumbs_AreRemoved', () => {
    const event = scrubEvent({
      breadcrumbs: [{ category: 'console', message: '<div>page html</div>' }],
      user: { ip_address: '203.0.113.7' },
      request: {
        url: 'http://localhost:3456/api/tts?text=a%20passage',
        query_string: 'text=a%20passage',
        data: '{"text":"a passage"}',
        cookies: { session: 'x' },
        headers: { authorization: 'Bearer x' },
      },
    })

    expect(event.breadcrumbs).toBeUndefined()
    expect(event.user).toBeUndefined()
    expect(event.request).toEqual({ url: 'http://localhost:3456/api/tts' })
  })

  it('scrubEvent_TagsOutsideAllowlist_AreDropped', () => {
    const event = scrubEvent({ tags: { service: SERVICE, 'ssg.route': '/en/books/x', html: '<p>' } })
    expect(event.tags).toEqual({ service: SERVICE, 'ssg.route': '/en/books/x' })
  })

  it('scrubEvent_ExtrasOutsideAllowlist_AreRedacted', () => {
    const event = scrubEvent({ extra: { reason: 'GET /x?q=secret failed', bodySnippet: '<p>text</p>' } })
    expect(event.extra).toEqual({ reason: 'GET /x failed', bodySnippet: REDACTED })
  })

  it('scrubEvent_ExceptionValue_IsCleaned', () => {
    const event = scrubEvent({ exception: { values: [{ type: 'Error', value: 'postgres://app:pw@db/books down' }] } })
    expect(event.exception.values[0].value).not.toContain('pw')
    expect(event.exception.values[0].type).toBe('Error')
  })
})

describe('routeFailuresToReport', () => {
  it('routeFailuresToReport_MixedResults_KeepsRealFailuresFirstLineOnly', () => {
    const failures = routeFailuresToReport([
      { route: '/en/books/ok', routeType: 'book', success: true },
      { route: '/en/books/draft', routeType: 'book', success: false, error: 'Page has noindex meta tag' },
      { route: '/en/books/dracula', routeType: 'book', success: false, error: RENDER_FAILURE },
    ])

    expect(failures).toEqual([
      { route: '/en/books/dracula', routeType: 'book', reason: 'prerender failed for /en/books/dracula' },
    ])
  })

  it('routeFailuresToReport_NotAnArray_ReturnsEmpty', () => {
    expect(routeFailuresToReport(null)).toEqual([])
    expect(routeFailuresToReport({ routes: [] })).toEqual([])
  })
})

describe('initSentry', () => {
  let reporter = null

  afterEach(async () => {
    await reporter?.close()
    reporter = null
  })

  it('initSentry_NoDsn_ReturnsNull', async () => {
    expect(await initSentry({})).toBeNull()
  })

  // A transport that records what WOULD have been sent, after every hook has run.
  function recordingTransport(sent) {
    return (options) =>
      createTransport(options, async (request) => {
        const body = typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body)
        for (const line of body.split('\n')) {
          try {
            const item = JSON.parse(line)
            if (item.event_id && (item.exception || item.message)) sent.push(item)
          } catch {
            // envelope headers that are not JSON objects of interest
          }
        }
        return { statusCode: 200 }
      })
  }

  it('initSentry_FakeDsn_StartsWithoutThrowing', async () => {
    reporter = await initSentry({ SENTRY_DSN: DSN })
    expect(reporter).not.toBeNull()
  })

  it('initSentry_RouteFailure_SendsTagsAndFirstLineNeverHtml', async () => {
    const sent = []
    reporter = await initSentry({ SENTRY_DSN: DSN, SENTRY_RELEASE: 'test' }, { transport: recordingTransport(sent) })

    console.log(`[prerender] ${RENDER_FAILURE}`) // would be a console breadcrumb with default integrations
    reporter.routesFailed(42, routeFailuresToReport([{ route: '/en/books/dracula', routeType: 'book', success: false, error: RENDER_FAILURE }]))
    await reporter.close()
    reporter = null

    expect(sent).toHaveLength(1)
    const [event] = sent
    expect(event.tags).toEqual({ service: SERVICE, 'ssg.job_id': '42', 'ssg.route': '/en/books/dracula', 'ssg.route_type': 'book' })
    expect(event.extra.reason).toBe('prerender failed for /en/books/dracula')
    expect(event.level).toBe('error')
    expect(event.fingerprint).toEqual(['ssg-route-failed'])
    expect(event.breadcrumbs).toBeUndefined()
    expect(JSON.stringify(event)).not.toContain('best of times')
  })

  it('initSentry_JobFailure_TaggedWithJobId', async () => {
    const sent = []
    reporter = await initSentry({ SENTRY_DSN: DSN, SENTRY_RELEASE: 'test' }, { transport: recordingTransport(sent) })

    reporter.jobFailed(7, new Error('Failed to fetch routes: 500 Internal Server Error'))
    await reporter.close()
    reporter = null

    expect(sent).toHaveLength(1)
    expect(sent[0].tags['ssg.job_id']).toBe('7')
    expect(sent[0].exception.values[0].value).toBe('Failed to fetch routes: 500 Internal Server Error')
  })

  // Caught in the docker smoke test: with withScope (and no OpenTelemetry context manager) a job's
  // tag stayed on the shared scope, and the NEXT event — an unrelated crash — arrived tagged with it.
  it('initSentry_JobTag_DoesNotLeakIntoLaterEvents', async () => {
    const sent = []
    reporter = await initSentry({ SENTRY_DSN: DSN, SENTRY_RELEASE: 'test' }, { transport: recordingTransport(sent) })

    reporter.jobFailed(7, new Error('job failed'))
    reporter.routesFailed(7, [{ route: '/en/books/x', routeType: 'book', reason: 'timeout' }])
    reporter.error(new Error('unrelated'))
    await reporter.close()
    reporter = null

    expect(sent).toHaveLength(3)
    expect(sent[2].tags).toEqual({ service: SERVICE })
    expect(sent[2].extra).toBeUndefined()
  })

  it('initSentry_ManyRouteFailures_AreCapped', async () => {
    const sent = []
    reporter = await initSentry({ SENTRY_DSN: DSN, SENTRY_RELEASE: 'test' }, { transport: recordingTransport(sent) })

    const failures = Array.from({ length: 50 }, (_, i) => ({ route: `/en/books/b${i}`, routeType: 'book', reason: 'timeout' }))
    reporter.routesFailed(9, failures)
    await reporter.close()
    reporter = null

    expect(sent).toHaveLength(MAX_ROUTE_EVENTS_PER_JOB)
    expect(sent[0].extra.failed_routes_in_job).toBe(50)
  })
})
