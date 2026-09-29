import assert from 'node:assert/strict'
import test from 'node:test'
import { TodoistClient, TodoistError, TODOIST_API_BASE_URL, TODOIST_REQUEST_TIMEOUT_MS, type TodoistTaskUpdatePayload } from '../src/todoist.ts'

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

function assertWriteCall(call: FetchCall, method: 'POST' | 'DELETE', requestId: string): void {
  assert.equal(call.init.method, method)
  const headers = new Headers(call.init.headers)
  assert.equal(headers.get('authorization'), `Bearer ${TEST_TOKEN}`)
  assert.equal(headers.get('accept'), 'application/json')
  assert.equal(headers.get('x-request-id'), requestId)
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

test('createTask posts the legacy request shape with an ISO due time and request ID', async () => {
  const calls: FetchCall[] = []
  const task = { id: 'created-task', content: 'Dinner', project_id: 'meal-project' }
  const client = clientWith([jsonResponse(task)], calls)
  const dueAt = '2026-09-30T18:30:00+05:30'

  assert.deepEqual(
    await client.createTask('Dinner', 'meal-project', dueAt, 'Asia/Kolkata', 'stable-request-1', 'meal marker'),
    task,
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url.toString(), `${TODOIST_API_BASE_URL}/tasks`)
  assertWriteCall(calls[0]!, 'POST', 'stable-request-1')
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    content: 'Dinner',
    project_id: 'meal-project',
    due_datetime: dueAt,
    due_timezone: 'Asia/Kolkata',
    description: 'meal marker',
  })
  assert.equal(new Headers(calls[0]!.init.headers).get('content-type'), 'application/json')
})

test('createTask requires a returned object with a non-empty ID', async () => {
  for (const response of [jsonResponse(null), jsonResponse([]), jsonResponse({}), jsonResponse({ id: '  ' })]) {
    await assert.rejects(
      clientWith([response]).createTask('Dinner', 'meal-project', '2026-09-30T18:30:00+05:30', 'Asia/Kolkata', 'request-1'),
      (error: unknown) => error instanceof TodoistError && error.message === 'Todoist did not return the created task',
    )
  }
})

test('all write methods require a non-empty request ID before making a request', async () => {
  const cases: Array<(client: TodoistClient) => Promise<unknown>> = [
    (client) => client.createTask('Dinner', 'meal-project', '2026-09-30T18:30:00+05:30', 'Asia/Kolkata', '  '),
    (client) => client.updateTask('task-1', {
      due_datetime: '2026-09-30T18:30:00+05:30', due_timezone: 'Asia/Kolkata',
    }, ''),
    (client) => client.deleteTask('task-1', '\t '),
  ]

  for (const invoke of cases) {
    let calls = 0
    const client = new TodoistClient(TEST_TOKEN, async () => {
      calls += 1
      return jsonResponse({ id: 'task-1' })
    })
    await assert.rejects(invoke(client), (error: unknown) => {
      assert.ok(error instanceof TodoistError)
      assert.equal(error.message, 'Todoist write request ID is required')
      return true
    })
    assert.equal(calls, 0)
  }
})

test('write requests keep the existing 20-second timeout', async () => {
  const originalTimeout = AbortSignal.timeout
  let timeoutMs = 0
  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    writable: true,
    value: (milliseconds: number) => {
      timeoutMs = milliseconds
      return new AbortController().signal
    },
  })

  try {
    await clientWith([new Response(null, { status: 204 })]).deleteTask('task-1', 'stable-request-timeout')
    assert.equal(timeoutMs, TODOIST_REQUEST_TIMEOUT_MS)
    assert.equal(timeoutMs, 20_000)
  } finally {
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      writable: true,
      value: originalTimeout,
    })
  }
})

test('updateTask posts only its typed allowed fields to an encoded task path', async () => {
  const calls: FetchCall[] = []
  const task = { id: 'task/one', project_id: 'meal-project', content: 'Dinner' }
  const client = clientWith([jsonResponse(task)], calls)
  const payload = {
    due_datetime: '2026-09-30T18:30:00+05:30',
    due_timezone: 'Asia/Kolkata',
    content: 'not an allowed update field',
  } as TodoistTaskUpdatePayload & { readonly content: string }

  assert.deepEqual(await client.updateTask('task/one', payload, 'stable-request-2'), task)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url.pathname, '/api/v1/tasks/task%2Fone')
  assertWriteCall(calls[0]!, 'POST', 'stable-request-2')
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    due_datetime: payload.due_datetime,
    due_timezone: payload.due_timezone,
  })
})

test('updateTask reads back when the POST response is absent or non-object', async () => {
  for (const updateResponse of [new Response(null, { status: 204 }), jsonResponse(null), jsonResponse([])]) {
    const calls: FetchCall[] = []
    const task = { id: 'task/one', project_id: 'meal-project', content: 'Dinner' }
    const client = clientWith([updateResponse, jsonResponse(task)], calls)
    const result = await client.updateTask('task/one', {
      due_datetime: '2026-09-30T18:30:00+05:30', due_timezone: 'Asia/Kolkata',
    }, 'stable-request-3')

    assert.deepEqual(result, task)
    assert.equal(calls.length, 2)
    assert.equal(calls[0]!.url.pathname, '/api/v1/tasks/task%2Fone')
    assertWriteCall(calls[0]!, 'POST', 'stable-request-3')
    assert.equal(calls[1]!.url.pathname, '/api/v1/tasks/task%2Fone')
    assertGetCall(calls[1]!)
  }
})

test('updateTask fails safely when the POST response has no readable task', async () => {
  const calls: FetchCall[] = []
  const client = clientWith([new Response(null, { status: 204 }), new Response(null, { status: 404 })], calls)

  await assert.rejects(client.updateTask('task-1', {
    due_datetime: '2026-09-30T18:30:00+05:30', due_timezone: 'Asia/Kolkata',
  }, 'stable-request-4'), (error: unknown) => {
    assert.ok(error instanceof TodoistError)
    assert.equal(error.message, 'Updated Todoist task could not be read back')
    return true
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.init.method, 'GET')
})

test('deleteTask treats 404 as absent and never follows a successful DELETE with GET', async () => {
  for (const response of [new Response(null, { status: 404 }), jsonResponse({ id: 'possibly-stale' })]) {
    const calls: FetchCall[] = []
    const client = clientWith([response], calls)

    await client.deleteTask('task/id with ?', 'stable-request-5')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url.pathname, '/api/v1/tasks/task%2Fid%20with%20%3F')
    assertWriteCall(calls[0]!, 'DELETE', 'stable-request-5')
    assert.equal(calls[0]!.init.body, undefined)
    assert.equal(new Headers(calls[0]!.init.headers).get('content-type'), null)
  }
})

test('write HTTP, transport, and parse errors stay sanitized', async () => {
  const httpFailure = clientWith([jsonResponse({ detail: `private body ${TEST_TOKEN}` }, 503)])
  await assert.rejects(httpFailure.deleteTask('task-1', 'stable-request-6'), (error: unknown) => {
    assert.ok(error instanceof TodoistError)
    assert.equal(error.message, 'Todoist request failed (HTTP 503)')
    assert.doesNotMatch(error.message, new RegExp(TEST_TOKEN, 'u'))
    assert.doesNotMatch(error.message, /private body/u)
    return true
  })

  const transportFailure = clientWith([new Error(`private transport detail ${TEST_TOKEN}`)])
  await assert.rejects(
    transportFailure.createTask('Dinner', 'meal-project', '2026-09-30T18:30:00+05:30', 'Asia/Kolkata', 'stable-request-7'),
    (error: unknown) => error instanceof TodoistError && error.message === 'Todoist could not be reached; try again',
  )

  const parseFailure = clientWith([new Response(`private parse detail ${TEST_TOKEN}`)])
  await assert.rejects(parseFailure.deleteTask('task-1', 'stable-request-8'), (error: unknown) => {
    assert.ok(error instanceof TodoistError)
    assert.equal(error.message, 'Todoist returned invalid JSON')
    assert.doesNotMatch(error.message, new RegExp(TEST_TOKEN, 'u'))
    assert.doesNotMatch(error.message, /private parse detail/u)
    return true
  })
})

test('the client exposes only the required write operations while all read transport stays GET', async () => {
  const calls: FetchCall[] = []
  const client = clientWith([
    jsonResponse({ items: [{ id: 'task-1', project_id: 'project-1' }] }),
    jsonResponse({ id: 'task-1', project_id: 'project-1' }),
  ], calls)

  await client.listTasks('project-1')
  await client.getTask('task-1')
  for (const method of ['createTask', 'updateTask', 'deleteTask']) assert.equal(typeof Reflect.get(client, method), 'function')
  assert.equal(Reflect.get(client, 'closeTask'), undefined)
  assert.deepEqual(calls.map((call) => call.init.method), ['GET', 'GET'])
  calls.forEach(assertGetCall)
})
