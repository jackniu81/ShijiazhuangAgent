import { Link } from 'react-router';

export default function Welcome() {
  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-4xl font-bold tracking-tight">
          Welcome 👋 !
        </h1>
        <p className="max-w-prose text-slate-600">
          A full-stack starter: a <strong>NestJS</strong> API that also hosts
          this <strong>React</strong> client (built with <strong>Vite</strong>{' '}
          and styled with <strong>Tailwind CSS</strong>).
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-2 font-semibold">What&apos;s inside</h2>
        <ul className="list-inside list-disc space-y-1 text-slate-600">
          <li>Sample API: <code className="rounded bg-slate-100 px-1">GET /api/version</code></li>
          <li>Two pages wired with React Router</li>
          <li>Dev proxy so the client can hit the API server easily</li>
        </ul>
      </div>

      <Link
        to="/about"
        className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        View API version →
      </Link>
    </section>
  );
}
