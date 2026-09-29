export const TODOIST_API_BASE_URL = 'https://api.todoist.com/api/v1'
export const TODOIST_REQUEST_TIMEOUT_MS = 20_000

export type TodoistIdentifier = string | number
export type TodoistFetch = typeof fetch

type TodoistRecord = Record<string, unknown>

export interface TodoistProject extends TodoistRecord {
  readonly id: TodoistIdentifier
  readonly name: string
}

export interface TodoistTask extends TodoistRecord {
  readonly id: TodoistIdentifier
  readonly project_id?: TodoistIdentifier | null
}

export interface TodoistTaskUpdatePayload {
  readonly due_datetime: string
  readonly due_timezone: string
}

export class TodoistError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TodoistError'
  }
}

function isRecord(value: unknown): value is TodoistRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIdentifier(value: unknown): value is TodoistIdentifier {
  return typeof value === 'string' || typeof value === 'number'
}

function asProject(value: unknown): TodoistProject {
  if (!isRecord(value) || !isIdentifier(value.id) || typeof value.name !== 'string') {
    throw new TodoistError('Todoist returned an unexpected project response')
  }
  return value as TodoistProject
}

function asTask(value: unknown): TodoistTask {
  if (!isRecord(value) || !isIdentifier(value.id)) {
    throw new TodoistError('Todoist returned an unexpected task response')
  }
  return value as TodoistTask
}

function listItems(payload: unknown): { readonly items: TodoistRecord[]; readonly nextCursor?: unknown } {
  if (Array.isArray(payload)) {
    if (!payload.every(isRecord)) throw new TodoistError('Todoist returned an unexpected list response')
    return { items: payload }
  }

  if (!isRecord(payload)) throw new TodoistError('Todoist returned an unexpected list response')
  const values = Array.isArray(payload.results) ? payload.results : payload.items
  if (!Array.isArray(values) || !values.every(isRecord)) {
    throw new TodoistError('Todoist returned an unexpected list response')
  }
  return { items: values, nextCursor: payload.next_cursor }
}

function encodedTaskIdentifier(taskId: TodoistIdentifier): string {
  const value = String(taskId)
  if (value.length === 0 || value === '.' || value === '..') {
    throw new TodoistError('Todoist task identifier is invalid')
  }
  try {
    return encodeURIComponent(value)
  } catch {
    throw new TodoistError('Todoist task identifier is invalid')
  }
}

function dateParameter(value: string | Date): string {
  if (typeof value === 'string') return value
  if (!Number.isFinite(value.getTime())) throw new TodoistError('Todoist date range is invalid')
  return value.toISOString()
}

function taskDueDateTime(value: string | Date): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TodoistError('Todoist task due date and time is invalid')
    return value.toISOString()
  }
  const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/u
  if (!isoDateTime.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TodoistError('Todoist task due date and time is invalid')
  }
  return value
}

function hasNonEmptyTaskId(value: unknown): value is TodoistIdentifier {
  if (typeof value === 'string') return value.trim().length > 0
  return typeof value === 'number' && Number.isFinite(value) && value !== 0
}

export class TodoistClient {
  private readonly token: string
  private readonly fetchImplementation: TodoistFetch

  constructor(token: string, fetchImplementation: TodoistFetch = globalThis.fetch) {
    if (token.length === 0) throw new TodoistError('Todoist token is required')
    this.token = token
    this.fetchImplementation = fetchImplementation
  }

  async findProject(name: string): Promise<TodoistProject> {
    const projects = await this.paginate('projects')
    const matches = projects.map(asProject).filter((project) => project.name === name)
    if (matches.length !== 1) {
      throw new TodoistError(`Expected exactly one Todoist project; found ${matches.length}`)
    }
    return matches[0]!
  }

  async listTasks(projectId: TodoistIdentifier): Promise<TodoistTask[]> {
    const tasks = await this.paginate('tasks', { project_id: String(projectId) })
    return tasks.map(asTask)
  }

  async getTask(taskId: TodoistIdentifier): Promise<TodoistTask | null> {
    const task = await this.get(`tasks/${encodedTaskIdentifier(taskId)}`, {}, true)
    return task === null ? null : asTask(task)
  }

  async completedTasks(
    projectId: TodoistIdentifier,
    since: string | Date,
    until: string | Date,
  ): Promise<TodoistTask[]> {
    const tasks = await this.paginate('tasks/completed/by_completion_date', {
      since: dateParameter(since),
      until: dateParameter(until),
    })
    return tasks
      .map(asTask)
      .filter((task) => task.project_id !== undefined && task.project_id !== null && String(task.project_id) === String(projectId))
  }

  async createTask(
    content: string,
    projectId: TodoistIdentifier,
    dueAt: string | Date,
    timezone: string,
    requestId: string,
    description = '',
  ): Promise<TodoistTask> {
    const response = await this.write('tasks', 'POST', requestId, {
      content,
      project_id: projectId,
      due_datetime: taskDueDateTime(dueAt),
      due_timezone: timezone,
      description,
    })
    if (!isRecord(response) || !hasNonEmptyTaskId(response.id)) {
      throw new TodoistError('Todoist did not return the created task')
    }
    return response as TodoistTask
  }

  async updateTask(
    taskId: TodoistIdentifier,
    payload: TodoistTaskUpdatePayload,
    requestId: string,
  ): Promise<TodoistTask> {
    const response = await this.write(`tasks/${encodedTaskIdentifier(taskId)}`, 'POST', requestId, {
      due_datetime: taskDueDateTime(payload.due_datetime),
      due_timezone: payload.due_timezone,
    })
    if (isRecord(response)) return asTask(response)

    const task = await this.getTask(taskId)
    if (!task) throw new TodoistError('Updated Todoist task could not be read back')
    return task
  }

  async deleteTask(taskId: TodoistIdentifier, requestId: string): Promise<void> {
    await this.write(`tasks/${encodedTaskIdentifier(taskId)}`, 'DELETE', requestId, undefined, true)
  }

  private async paginate(path: string, params: Record<string, string> = {}): Promise<TodoistRecord[]> {
    const items: TodoistRecord[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined

    while (true) {
      const query: Record<string, string> = { ...params, limit: '200' }
      if (cursor !== undefined) query.cursor = cursor
      const payload = await this.get(path, query)
      const page = listItems(payload)
      items.push(...page.items)

      const nextCursor = page.nextCursor
      if (nextCursor === undefined || nextCursor === null || nextCursor === '') return items
      if (typeof nextCursor !== 'string') throw new TodoistError('Todoist returned an invalid pagination cursor')
      if (seenCursors.has(nextCursor)) throw new TodoistError('Todoist returned a repeated pagination cursor')
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }
  }

  private async get(path: string, params: Record<string, string>, notFoundIsNull = false): Promise<unknown | null> {
    const url = new URL(path, `${TODOIST_API_BASE_URL}/`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

    const signal = AbortSignal.timeout(TODOIST_REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await this.fetchImplementation(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
        },
        signal,
      })
    } catch {
      if (signal.aborted) throw new TodoistError('Todoist request timed out; try again')
      throw new TodoistError('Todoist could not be reached; try again')
    }

    if (response.status === 404 && notFoundIsNull) return null
    if (!response.ok) throw new TodoistError(`Todoist request failed (HTTP ${response.status})`)
    if (response.status === 204) return null

    let body: string
    try {
      body = await response.text()
    } catch {
      throw new TodoistError('Todoist response could not be read')
    }
    if (body.length === 0) return null

    try {
      return JSON.parse(body) as unknown
    } catch {
      throw new TodoistError('Todoist returned invalid JSON')
    }
  }

  private async write(
    path: string,
    method: 'POST' | 'DELETE',
    requestId: string,
    payload?: Record<string, unknown>,
    notFoundIsSuccess = false,
  ): Promise<unknown | null> {
    if (typeof requestId !== 'string' || requestId.trim().length === 0) {
      throw new TodoistError('Todoist write request ID is required')
    }

    const url = new URL(path, `${TODOIST_API_BASE_URL}/`)
    const signal = AbortSignal.timeout(TODOIST_REQUEST_TIMEOUT_MS)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      'X-Request-ID': requestId,
    }
    const init: RequestInit = { method, headers, signal }
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(payload)
    }

    let response: Response
    try {
      response = await this.fetchImplementation(url, init)
    } catch {
      if (signal.aborted) throw new TodoistError('Todoist request timed out; try again')
      throw new TodoistError('Todoist could not be reached; try again')
    }

    if (notFoundIsSuccess && response.status === 404) return null
    if (!response.ok) throw new TodoistError(`Todoist request failed (HTTP ${response.status})`)
    if (response.status === 204) return null

    let body: string
    try {
      body = await response.text()
    } catch {
      throw new TodoistError('Todoist response could not be read')
    }
    if (body.length === 0) return null

    try {
      return JSON.parse(body) as unknown
    } catch {
      throw new TodoistError('Todoist returned invalid JSON')
    }
  }
}
