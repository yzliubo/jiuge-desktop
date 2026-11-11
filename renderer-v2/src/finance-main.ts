import { createApp } from 'vue';
import FinanceView from './views/FinanceView.vue';
import { localDate } from './types';
import { onDataChanged } from './bridge';
import './styles/tokens.css';

// 独立账本窗口的挂载点：与主窗共用同一个 preload、同一份 md_finance，
// 没有第二条数据通道，也没有跨窗口直连。
// runtime-only 预编译 SFC，严格 CSP 下不需要 unsafe-eval。
createApp(FinanceView, { today: localDate() }).mount('#app');

// 主进程按 key 精确广播数据变更；独立窗口收到后让视图自己重取一次，
// 避免主窗记一笔、账本窗口还停在旧数。
onDataChanged(function () {
  window.dispatchEvent(new Event('finance:refresh'));
});
