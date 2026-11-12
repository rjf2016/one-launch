import { createServer } from 'node:http';

export function closedPort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

const sortedHeaders = (headers) =>
  Object.fromEntries(
    Object.keys(headers)
      .sort()
      .map((name) => [name, headers[name]]),
  );

export class Feed {
  constructor(answer, phase = () => null) {
    this.answer = answer;
    this.phase = phase;
    this.requests = [];
    this.server = null;
    this.port = null;
    this.sockets = new Set();
  }

  async listen() {
    this.server = createServer((req, res) => void this.serve(req, res));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise((done) => this.server.listen(0, '127.0.0.1', done));
    this.port = this.server.address().port;
    return this.port;
  }

  async serve(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const record = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries([...url.searchParams.entries()]),
      headers: sortedHeaders(req.headers),
      answer: null,
    };
    this.requests.push(record);
    let gone = false;
    let closed = null;
    const closing = new Promise((done) => {
      closed = done;
    });
    res.on('error', () => {
      gone = true;
    });
    res.on('close', () => {
      if (!res.writableFinished) gone = true;
      closed(this.phase());
    });
    res.sendDate = false;
    try {
      const { status, parts, hold } = await this.answer(record, this.requests.length - 1);
      if (hold) {
        record.answer = { status: null, held: hold };
        record.answer = { status: null, held: hold, closedDuring: await closing };
        return;
      }
      if (gone) {
        record.answer = { status: null, aborted: 'before the answer' };
        return;
      }
      const bytes = parts.filter((p) => Buffer.isBuffer(p)).reduce((n, p) => n + p.length, 0);
      res.writeHead(status, bytes > 0 ? { 'content-type': 'application/octet-stream', 'content-length': bytes } : { 'content-length': 0 });
      let sent = 0;
      for (const part of parts) {
        if (gone) break;
        if (Buffer.isBuffer(part)) {
          res.write(part);
          sent += part.length;
        } else {
          await part();
        }
      }
      res.end();
      record.answer = gone ? { status, bytes, sent, aborted: 'during the body' } : { status, bytes };
    } catch (err) {
      record.answer = { status: null, error: err instanceof Error ? err.message : String(err) };
      res.destroy();
    }
  }

  async close() {
    if (!this.server) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise((done) => this.server.close(done));
    this.server = null;
  }
}
