# 2026-10-22 系统设置首屏提速

- 现象：点进系统设置卡顿。各步服务端都是毫秒级（取配置的 action 7-10ms），但链路上有三次串行往返：导航取页面数据 → 下载页面专属 JS（含用不到的后端池面板）→ 客户端挂载后再发 `getSystemSettingsAction` 取配置。网络延迟高、丢包多时，往返次数就是全部成本。
- 方案（`c3093f2`、`5844ed8`）：
  - `admin/settings/page.tsx` 在超管鉴权后调用 `getAdminSystemSettingsSnapshot()`（与 action 同一函数、同一 `canManageUserPermissions` 守卫，密钥不回显），构造 `<SystemSettingsPanel initialSettings>` 传给 tab 外壳。首屏直接有内容；保存、导入、初始化后仍经 action 重新加载。
  - 后端池面板（`admin-panel.tsx`，约 5000 行）只经 `admin/settings/lazy-pool-panel.tsx`（`next/dynamic`）引用。超管停在系统设置时不下载它，首屏 1.5s 后预取。
- 效果：超管首屏 JS 从 gzip 357KB 降到 330KB，后端池面板移出首屏，少一次取数往返；HTML 与 RSC 负载里密钥命中 0 次。
- **约定**：Next App Router 会把页面模块图里静态导入的所有客户端组件都打进首屏入口 chunk，与是否渲染无关（只在服务端按条件构造元素不能减少下载量）。重的、按条件才显示的面板要经 `next/dynamic` 引用。验证方法：用面板独有的文案 grep 首屏 chunk。
