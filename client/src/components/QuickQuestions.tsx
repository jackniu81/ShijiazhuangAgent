interface Props {
  questions: string[];
  disabled: boolean;
  onSelect: (question: string) => void;
}

/** 空会话时展示的预置快速提问气泡,点击后由上层发送给 agent。 */
export default function QuickQuestions({ questions, disabled, onSelect }: Props) {
  return (
    <div className="flex flex-col items-start gap-1.5" data-testid="quick-questions">
      <span className="text-xs text-slate-400">你可以这样问我:</span>
      {questions.map((q) => (
        <button
          key={q}
          type="button"
          onClick={() => onSelect(q)}
          disabled={disabled}
          className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid={`quick-question-${q}`}
        >
          <span aria-hidden>🤖</span>
          {q}
        </button>
      ))}
    </div>
  );
}
