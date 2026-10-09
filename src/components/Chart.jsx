import React, {useEffect, useRef} from 'react';
import * as echarts from 'echarts/core';
import {BarChart, LineChart, PieChart} from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import {CanvasRenderer} from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export function Chart({option, height}) {
  const host = useRef(null);

  useEffect(() => {
    if (!host.current) return undefined;
    const chart = echarts.init(host.current, null, {renderer: 'canvas'});
    chart.setOption(option);
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
    };
  }, [option]);

  return <div className="chart" style={{height: height || 280}} ref={host} />;
}
