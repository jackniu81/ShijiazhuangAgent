import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import QuickQuestions from '../components/QuickQuestions';

const QUESTIONS = ['古城1日游推荐', '石家庄+古城2日游行程'];

describe('QuickQuestions', () => {
  it('渲染标题与全部问题气泡', () => {
    render(<QuickQuestions questions={QUESTIONS} disabled={false} onSelect={vi.fn()} />);
    expect(screen.getByText('你可以这样问我:')).toBeInTheDocument();
    expect(screen.getByTestId('quick-question-古城1日游推荐')).toBeInTheDocument();
    expect(screen.getByTestId('quick-question-石家庄+古城2日游行程')).toBeInTheDocument();
  });

  it('点击气泡回调 onSelect 并携带问题文本', () => {
    const onSelect = vi.fn();
    render(<QuickQuestions questions={QUESTIONS} disabled={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('quick-question-古城1日游推荐'));
    expect(onSelect).toHaveBeenCalledWith('古城1日游推荐');
  });

  it('disabled 时气泡禁用且点击不触发回调', () => {
    const onSelect = vi.fn();
    render(<QuickQuestions questions={QUESTIONS} disabled onSelect={onSelect} />);
    const btn = screen.getByTestId('quick-question-古城1日游推荐');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
