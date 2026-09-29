import assert from 'node:assert/strict'
import test from 'node:test'
import { TodoistClient, TodoistError, TODOIST_API_BASE_URL, TODOIST_REQUEST_TIMEOUT_MS } from '../src/todoist.ts'

const TEST_TOKEN = 'fake-todoist-token-for-offline-tests'

type FetchCall = { readonly url: URL; readonly init: RequestInit }
type FakeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function clientWith(responses: Array<Response | Error>, calls: FetchCall[] = []): TodoistClient {
  let index = 0
  const fakeFetch: FakeFetch = async (input, init = {}) => {
    calls.push({ url: new URL(String(input)), init })
    const response = responses[index++]
    if (!response) throw new Error('fake fetch response queue exhausted')
    if (response instanceof Error) throw response
    return response
  }
  return new TodoistClient(TEST_TOKEN, fakeFetch)
}

function assertGetCall(call: FetchCall): void {
  assert.equal(call.init.method, 'GET')
  const headers = new Headers(call.init.headers)
  assert.equal(headers.get('authorization'), `Bearer ${TEST_TOKEN}`)
  assert.equal(headers.get('accept'), 'application/json')
  assert.ok(call.init.signal instanceof AbortSignal)
}

test('client uses the fixed API base, bearer and JSON headers, GET, and a 20-second timeout', async () => {
  const calls: FetchCall[] = []
  const client = clientWith([jsonResponse({ id: 'task-1', project_id: 'project-1' })], calls)

  assert.deepEqual(await client.getTask('task-1'), { id: 'task-1', project_id: 'project-1' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url.toString(), `${TODOIST_API_BASE_URL}/tasks/task-1`)
  assertGetCall(calls[0]!)
  assert.equal(TODOIST_REQUEST_TIMEOUT_MS, 20_000)
})

test('listTasks accepts a top-level array and sends project_id with limit 200', async () => {
  const calls: FetchCall[] = []
  const client = clientWith([jsonResponse([{ id: 'task-1', project_id: 'meal-project' }])], calls)

  assert.deepEqual(await client.listTasks('meal-project'), [{ id: 'task-1', project_id: 'meal-project' }])
  assert.equal(calls[0]!.url.origin + calls[0]!.url.pathname, `${TODOIST_API_BASE_URL}/tasks`)
  assert.equal(calls[0]!.url.searchParams.get('project_id'), 'meal-project')
  assert.equal(calls[0]!.url.searchParams.get('limit'), '200')
  assert.equal(calls[0]!.url.searchParams.has('cursor'), false)
  assertGetCall(calls[0]!)
})

test('pagination accepts results and items, uses next_cursor, and keeps limit at 200', async () => {
  const calls: FetchCall[] = []
  const client = clientWith([
    jsonResponse({ results: [{ id: 'task-1', project_id: 'project-1' }], next_cursor: 'page two / + token' }),
    jsonResponse({ items: [{ id: 'task-2', project_id: 'project-1' }] }),
  ], calls)

  assert.deepEqual(await client.listTasks('project-1'), [
    { id: 'task-1', project_id: 'project-1' },
    { id: 'task-2', project_id: 'project-1' },
  ])
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.url.searchParams.get('limit'), '200')
    assert.equal(call.url.searchParams.get('project_id'), 'project-1')
    assertGetCall(call)
  }
  assert.equal(calls[0]!.url.searchParams.has('cursor'), false)
  assert.equal(calls[1]!.url.searchParams.get('cursor'), 'page two / + token')
})

test('findProject matches the exact name and requires exactly one match', async () => {
  const client = clientWith([jsonResponse({ results: [
    { id: 'near', name: 'Meals ' },
    { id: 'meal-project', name: 'Meals' },
  ] })])
  assert.deepEqual(await client.findProject('Meals'), { id: 'meal-project', name: 'Meals' })

  await assert.rejects(
    clientWith([jsonResponse({ items: [
      { id: 'one', name: 'Meals' },
      { id: 'two', name: 'Meals' },
    ] })]).findProject('Meals'),
    (error: unknown) => error instanceof TodoistError && error.message === 'Expected exactly one Todoist project; found 2',
  )
  await assert.rejects(
    clientWith([jsonResponse([{ id: 'one', name: 'meals' }])]).findProject('Meals'),
    /found 0/u,
  )
})

test('getTask URL-encodes an identifier and returns null on 404', async () => {
  const calls: FetchCall[] = []
  const client = clientWith([jsonResponse({ id: 'task/with? special' }), new Response(null, { status: 404 })], calls)

  assert.deepEqual(await client.getTask('task/id with ?&'), { id: 'task/with? special' })
  assert.equal(calls[0]!.url.pathname, '/api/v1/tasks/task%2Fid%20with%20%3F%26')
  assert.equal(await client.getTask('missing-task'), null)
  assert.equal(calls[1]!.url.pathname, '/api/v1/tasks/missing-task')
  calls.forEach(assertGetCall)
})

test('404 is an HTTP error for collection reads', async () => {
  await assert.rejects(
    clientWith([new Response(null, { status: 404 })]).listTasks('project-1'),
    (error: unknown) => error instanceof TodoistError && error.message === 'Todoist request failed (HTTP 404)',
  )
})

test('completedTasks sends since and until, paginates, and filters by project ID', async () => {
  const calls: FetchCall[] = []
  const since = '2026-09-01T00:00:00+05:30'
  const until = '2026-10-01T00:00:00+05:30'
  const client = clientWith([
    jsonResponse({ results: [
      { id: 'meal-1', project_id: 'meal-project' },
      { id: 'other-1', project_id: 'other-project' },
    ], next_cursor: 'next' }),
    jsonResponse({ items: [
      { id: 'meal-2', project_id: 'meal-project' },
      { id: 'missing-project' },
    ] }),
  ], calls)

  assert.deepEqual(await client.completedTasks('meal-project', since, until), [
    { id: 'meal-1', project_id: 'meal-project' },
    { id: 'meal-2', project_id: 'meal-project' },
  ])
  for (const call of calls) {
    assert.equal(call.url.pathname, '/api/v1/tasks/completed/by_completion_date')
    assert.equal(call.url.searchParams.get('since'), since)
    assert.equal(call.url.searchParams.get('until'), until)
    assert.equal(call.url.searchParams.get('limit'), '200')
    assertGetCall(call)
  }
  assert.equal(calls[1]!.url.searchParams.get('cursor'), 'next')
})

test('malformed list payloads and malformed JSON become safe TodoistError messages', async () => {
  await assert.rejects(
    clientWith([jsonResponse({ data: [] })]).listTasks('project-1'),
    (error: unknown) => error instanceof TodoistError && error.message === 'Todoist returned an unexpected list response',
  )
  await assert.rejects(
    clientWith([new Response('{ not json')]).listTasks('project-1'),
    (error: unknown) => error instanceof TodoistError && error.message === 'Todoist returned invalid JSON',
  )
})

test('HTTP failures never expose the token or response body', async () => {
  const client = clientWith([jsonResponse({ error: `private body mentions ${TEST_TOKEN}` }, 401)])
  await assert.rejects(client.listTasks('project-1'), (error: unknown) => {
    assert.ok(error instanceof TodoistError)
    assert.match(error.message, /HTTP 401/u)
    assert.doesNotMatch(error.message, new RegExp(TEST_TOKEN, 'u'))
    assert.doesNotMatch(error.message, /private body/u)
    return true
  })
})

test('network failures become safe TodoistError messages', async () => {
  const client = clientWith([new Error(`network details ${TEST_TOKEN}`)])
  await assert.rejects(client.listTasks('project-1'), (error: unknown) => {
    assert.ok(error instanceof TodoistError)
    assert.equal(error.message, 'Todoist could not be reached; try again')
    assert.doesNotMatch(error.message, new RegExp(TEST_TOKEN, 'u'))
    return true
  })
})

test('the 20-second timeout is passed to fetch and timeout failures stay sanitized', async () => {
  const originalTimeout = AbortSignal.timeout
  let timeoutMs = 0
  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    writable: true,
    value: (milliseconds: number) => {
      timeoutMs = milliseconds
      const controller = new AbortController()
      controller.abort(new DOMException(TEST_TOKEN, 'TimeoutError'))
      return controller.signal
    },
  })

  try {
    const client = new TodoistClient(TEST_TOKEN, async (_input, init) => {
      assert.equal(init?.signal?.aborted, true)
      throw new Error(`timeout transport detail ${TEST_TOKEN}`)
    })
    await assert.rejects(client.getTask('task-1'), (error: unknown) => {
      assert.ok(error instanceof TodoistError)
      assert.equal(error.message, 'Todoist request timed out; try again')
      assert.doesNotMatch(error.message, new RegExp(TEST_TOKEN, 'u'))
      return true
    })
    assert.equal(timeoutMs, 20_000)
  } finally {
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      writable: true,
      value: originalTimeout,
    })
  }
})

test('repeated pagination cursors are rejected without exposing cursor text', async () => {
  const calls: FetchCall[] = []
  const client = clientWith([
    jsonResponse({ items: [{ id: 'task-1' }], next_cursor: TEST_TOKEN }),
    jsonResponse({ items: [{ id: 'task-2' }], next_cursor: TEST_TOKEN }),
  ], calls)

  await assert.rejects(client.listTasks('project-1'), (error: unknown) => {
    assert.ok(error instanceof TodoistError)
    assert.equal(error.message, 'Todoist returned a repeated pagination cursor')
    assert.doesNotMatch(error.message, new RegExp(TEST_TOKEN, 'u'))
    return true
  })
  assert.equal(calls.length, 2)
  calls.forEach(assertGetCall)
})

test('the client exposes read operations only and every transport call is GET', async () => {
  const calls: FetchCall[] = []
  const client = clientWith([
    jsonResponse({ items: [{ id: 'task-1', project_id: 'project-1' }] }),
    jsonResponse({ id: 'task-1', project_id: 'project-1' }),
  ], calls)

  await client.listTasks('project-1')
  await client.getTask('task-1')
  for (const method of ['createTask', 'updateTask', 'closeTask', 'deleteTask']) {
    assert.equal(Reflect.get(client, method), undefined)
  }
  assert.deepEqual(calls.map((call) => call.init.method), ['GET', 'GET'])
  calls.forEach(assertGetCall)
})
