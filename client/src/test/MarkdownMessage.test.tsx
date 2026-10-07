import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MarkdownMessage from '../components/MarkdownMessage';

describe('MarkdownMessage', () => {
  it('renders headings, lists and bold', () => {
    render(
      <MarkdownMessage
        text={'## 行程\n- 第一站\n- 第二站\n\n**门票** 50 元'}
      />,
    );
    expect(screen.getByText('行程').tagName).toBe('H3');
    const li = screen.getByText('第一站');
    expect(li.tagName).toBe('LI');
    expect(li.parentElement?.tagName).toBe('UL');
    expect(screen.getByText('门票').tagName).toBe('STRONG');
  });

  it('strips leading blank lines so no empty first line shows', () => {
    const { container } = render(<MarkdownMessage text={'\n\n  正文'} />);
    const ps = container.querySelectorAll('p');
    expect(ps).toHaveLength(1);
    expect(ps[0].textContent).toBe('正文');
  });

  it('does not render raw html', () => {
    const { container } = render(
      <MarkdownMessage text={'<img src=x onerror=alert(1)>'} />,
    );
    expect(container.querySelector('img')).toBeNull();
  });
});
