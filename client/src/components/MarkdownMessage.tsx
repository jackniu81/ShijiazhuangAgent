import ReactMarkdown from 'react-markdown';

interface Props {
  text: string;
}

export default function MarkdownMessage({ text }: Props) {
  return (
    <div className="text-sm leading-relaxed">
      <ReactMarkdown
        components={{
          p: ({ children }) => (
            <p className="m-0 first:mt-0 [&:not(:first-child)]:mt-2">
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="my-1.5 list-disc pl-5 [&:first-child]:mt-0">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1.5 list-decimal pl-5 [&:first-child]:mt-0">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="[&:not(:first-child)]:mt-1">{children}</li>
          ),
          h1: ({ children }) => (
            <h2 className="mt-2.5 text-base font-semibold [&:first-child]:mt-0">
              {children}
            </h2>
          ),
          h2: ({ children }) => (
            <h3 className="mt-2.5 text-base font-semibold [&:first-child]:mt-0">
              {children}
            </h3>
          ),
          h3: ({ children }) => (
            <h4 className="mt-2 text-sm font-semibold [&:first-child]:mt-0">
              {children}
            </h4>
          ),
          h4: ({ children }) => (
            <h5 className="mt-2 text-sm font-semibold [&:first-child]:mt-0">
              {children}
            </h5>
          ),
          h5: ({ children }) => (
            <h6 className="mt-2 text-sm font-semibold [&:first-child]:mt-0">
              {children}
            </h6>
          ),
          h6: ({ children }) => (
            <h6 className="mt-2 text-sm font-semibold [&:first-child]:mt-0">
              {children}
            </h6>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-emerald-600 underline underline-offset-2"
            >
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-1.5 overflow-x-auto rounded-md bg-slate-100 p-2 text-xs first:mt-0">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-1.5 border-l-2 border-slate-300 pl-3 text-slate-500 first:mt-0">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-2 border-slate-200" />,
          table: ({ children }) => (
            <table className="my-1.5 w-full border-collapse text-xs first:mt-0">
              {children}
            </table>
          ),
          th: ({ children }) => (
            <th className="border border-slate-200 px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-slate-200 px-2 py-1">{children}</td>
          ),
        }}
      >
        {text.replace(/^\s+/, '')}
      </ReactMarkdown>
    </div>
  );
}
