import { useEffect, useState } from 'react';
import { fetchVersion, type ApiVersion } from '../lib/api';

type Status = 'loading' | 'ok' | 'error';

export default function About() {
  const [status, setStatus] = useState<Status>('loading');
  const [data, setData] = useState<ApiVersion | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setStatus('loading');
    setError(null);
    try {
      const v = await fetchVersion();
      setData(v);
      setStatus('ok');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">About</h1>
        <p className="text-slate-600">
          This data comes from the live API:{' '}
          <code className="rounded bg-slate-100 px-1">GET /api/version</code>
        </p>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        {status === 'loading' && <p className="text-slate-500">Loading…</p>}

        {status === 'error' && (
          <div className="space-y-3">
            <p className="text-red-600">Failed to load: {error}</p>
            <button
              onClick={() => void load()}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
            >
              Retry
            </button>
          </div>
        )}

        {status === 'ok' && data && (
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Row label="API name" value={data.name} />
            <Row label="API version" value={data.version} />
            <Row label="Node runtime" value={data.node} />
            <Row label="Server time" value={data.timestamp} />
            <Row label="UI version" value={`v${__APP_VERSION__}`} />
          </dl>
        )}
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs uppercase tracking-wide text-slate-400">
        {label}
      </dt>
      <dd className="font-mono text-sm text-slate-800">{value}</dd>
    </div>
  );
}
