interface Props {
  text: string;
}

/**
 * 流式输出时的打字机效果 —— 实际上就是逐字追加文本,光标用 CSS blink 动画。
 * 纯展示组件,不负责节流/动画节流(由父组件的 token 推送节奏决定)。
 */
export default function StreamingText({ text }: Props) {
  return (
    <p className="whitespace-pre-wrap leading-relaxed">
      {text}
      <span
        aria-hidden
        className="ml-0.5 inline-block h-4 w-[2px] translate-y-[2px] animate-blink bg-slate-700"
      />
    </p>
  );
}
