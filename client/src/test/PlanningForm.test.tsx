import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PlanningForm from '../components/PlanningForm';
import type { PlanCreatePayload } from '../lib/types';

type Input = PlanCreatePayload['input'];

describe('PlanningForm', () => {
  const defaultSubmit = vi.fn((_input: Input) => {});

  it('renders all fields with defaults', () => {
    render(<PlanningForm onSubmit={defaultSubmit} />);
    // 天数默认 2
    expect(screen.getByTestId('days')).toHaveValue(2);
    expect(screen.getByTestId('startDate')).toHaveValue('');
    expect(screen.getByTestId('travelers')).toHaveValue(1);
    expect(screen.getByTestId('budget')).toHaveValue('');
    expect(screen.getByTestId('preferences')).toHaveValue('');
    // 预算选项
    expect(screen.getByText('经济')).toBeInTheDocument();
    expect(screen.getByText('舒适')).toBeInTheDocument();
    expect(screen.getByText('豪华')).toBeInTheDocument();
    // 兴趣标签
    expect(screen.getByTestId('interest-历史')).toBeInTheDocument();
    expect(screen.getByTestId('interest-美食')).toBeInTheDocument();
  });

  it('accepts initial values (for re-plan scenario)', () => {
    render(
      <PlanningForm
        onSubmit={defaultSubmit}
        initial={{
          days: 3,
          travelers: 4,
          budget: 'luxury',
          interests: ['美食', '文化'],
          preferences: '带老人',
        }}
      />
    );
    expect(screen.getByTestId('days')).toHaveValue(3);
    expect(screen.getByTestId('travelers')).toHaveValue(4);
    expect(screen.getByTestId('budget')).toHaveValue('luxury');
    expect(screen.getByTestId('preferences')).toHaveValue('带老人');
  });

  it('validates days: must be 1-7', () => {
    const submit = vi.fn();
    const { container } = render(<PlanningForm onSubmit={submit} />);
    const input = screen.getByTestId('days') as HTMLInputElement;
    const form = container.querySelector('form')!;

    // 原生 setter 绕过 type="number" + max 原生校验
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      '10'
    );
    fireEvent.submit(form);

    // 非法天数应该阻止提交
    expect(submit).not.toHaveBeenCalled();
  });

  it('submit emits Input shape with defined optional fields only', () => {
    const submit = vi.fn();
    render(<PlanningForm onSubmit={submit} />);

    // 填完整
    fireEvent.change(screen.getByTestId('days'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('startDate'), {
      target: { value: '2026-10-01' },
    });
    fireEvent.change(screen.getByTestId('travelers'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByTestId('budget'), {
      target: { value: 'comfort' },
    });
    fireEvent.click(screen.getByTestId('interest-历史'));
    fireEvent.click(screen.getByTestId('interest-美食'));

    const ta = screen.getByTestId('preferences') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '想多吃' } });

    fireEvent.click(screen.getByText('生成行程'));

    expect(submit).toHaveBeenCalledTimes(1);
    const input = submit.mock.calls[0][0] as Input;
    expect(input).toMatchObject({
      days: 3,
      startDate: '2026-10-01',
      travelers: 2,
      budget: 'comfort',
      interests: ['历史', '美食'],
      preferences: '想多吃',
    });
  });

  it('submit omits empty optional fields (undefined)', () => {
    const submit = vi.fn();
    render(<PlanningForm onSubmit={submit} />);

    // 只填必填项 days
    fireEvent.change(screen.getByTestId('days'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('生成行程'));

    expect(submit).toHaveBeenCalledTimes(1);
    const input = submit.mock.calls[0][0] as Input;
    expect(input.days).toBe(2);
    expect(input.startDate).toBeUndefined();
    expect(input.budget).toBeUndefined();
    expect(input.interests).toBeUndefined();
    expect(input.preferences).toBeUndefined();
  });
});
