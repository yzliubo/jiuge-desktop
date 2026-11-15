// T15 键盘底座：模态浮层统一的「Esc 关闭 + 焦点进入 + 关闭归还」。
// 为什么做成 composable 而不是 <Modal> 组件：现有两个弹窗（速记 / 胶囊）各有
// 自己的版式与过渡，抽组件要改模板结构，风险远大于抽行为；行为统一后，
// 将来新增弹窗只需在根节点挂 ref 再调一次本函数。
import { onMounted, onBeforeUnmount, type Ref } from 'vue';

/** 可聚焦元素优先级：输入框优先于按钮，保证「打开就能打字」。 */
const FOCUSABLE = 'textarea, input, select, button, a[href], [tabindex]:not([tabindex="-1"])';

export function useDialogFocus(root: Ref<HTMLElement | null>, onClose: () => void): void {
  let previous: HTMLElement | null = null;

  // 捕获阶段挂在弹窗根节点：焦点只要还在弹窗内，Esc 就一定收得到；
  // stopPropagation 同时挡住 App.vue 的全局 Escape（避免「关弹窗顺手关掉右栏抽屉」）。
  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    onClose();
  }

  // 焦点圈：Tab / Shift+Tab 不跑到弹窗背后的页面上（aria-modal=true 的起码语义）。
  function trapTab(ev: KeyboardEvent): void {
    if (ev.key !== 'Tab') return;
    const el = root.value;
    if (!el) return;
    const list = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((n) => !n.hasAttribute('disabled') && n.getAttribute('aria-disabled') !== 'true');
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (ev.shiftKey && active === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
    else if (active && !el.contains(active)) { ev.preventDefault(); first.focus(); }
  }

  onMounted(() => {
    previous = document.activeElement as HTMLElement | null;
    const el = root.value;
    if (!el) return;
    el.addEventListener('keydown', onKeydown, true);
    el.addEventListener('keydown', trapTab, true);
    // 已经由组件自己聚焦过（速记浮窗 R-09 要求 ≤500ms 可输入）就不抢焦点。
    if (el.contains(document.activeElement)) return;
    const first = el.querySelector<HTMLElement>(FOCUSABLE);
    if (first) first.focus();
    else { el.setAttribute('tabindex', '-1'); el.focus(); }
  });

  onBeforeUnmount(() => {
    const el = root.value;
    if (el) {
      el.removeEventListener('keydown', onKeydown, true);
      el.removeEventListener('keydown', trapTab, true);
    }
    // 关闭归还：把焦点还给打开它的那个按钮，不让焦点掉回 body。
    if (previous && previous.isConnected && typeof previous.focus === 'function') {
      previous.focus();
    }
  });
}
