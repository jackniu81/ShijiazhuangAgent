import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PlanCard from '../components/PlanCard';
import type { TravelPlan } from '../lib/types';

const PLAN: TravelPlan = {
  title: '石家庄 2 日游',
  summary: '经典组合行程',
  days: [
    {
      day: 1,
      items: [
        { time: '09:00', title: '正定古城', place: '正定县', description: '千年古城墙', tips: '免费' },
      ],
    },
    {
      day: 2,
      items: [
        { title: '西柏坡', place: '平山县' },
      ],
    },
  ],
  tips: ['9-11 月最舒适', '地铁覆盖好'],
};

describe('PlanCard', () => {
  it('renders title, summary, days, items, tips', () => {
    render(<PlanCard plan={PLAN} />);
    expect(screen.getByText('石家庄 2 日游')).toBeInTheDocument();
    expect(screen.getByText('经典组合行程')).toBeInTheDocument();
    expect(screen.getByText('正定古城')).toBeInTheDocument();
    expect(screen.getByText('@ 正定县')).toBeInTheDocument();
    expect(screen.getByText('千年古城墙')).toBeInTheDocument();
    expect(screen.getByText('💡 免费')).toBeInTheDocument();
    expect(screen.getByText(/9-11 月最舒适/)).toBeInTheDocument();
    expect(screen.getByText(/地铁覆盖好/)).toBeInTheDocument();
  });

  it('omits optional fields when missing', () => {
    const minimal: TravelPlan = {
      title: '1 日游',
      days: [{ day: 1, items: [{ title: '某地' }] }],
    };
    render(<PlanCard plan={minimal} />);
    expect(screen.getByText('1 日游')).toBeInTheDocument();
    expect(screen.getByText('某地')).toBeInTheDocument();
    // summary / tips 不应出现
    expect(screen.queryByText(/💡 小贴士/)).not.toBeInTheDocument();
  });
});
