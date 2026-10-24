/**
 * UOL Operations - 全域操作注册桶导入
 *
 * 职责：副作用导入所有域操作文件，触发 defineOperation 注册。
 * 应用启动时由 uol/index.ts 或顶层入口 import 此文件，
 * 确保所有操作在 registry 中可用。
 *
 * 新增域时在此追加 import 即可。
 */

// 图像生成域
import "./image-generation";
// 可编辑文件(PPT/PSD)生成(归 image-generation 域)
import "./editable-file";
// 积分域
import "./credits";
// 管理员充值（独立契约，复用原子资金/审计服务）
import "./credits-admin-grant";
// 订阅域
import "./subscription";
import "./creem-webhook";
// 用户认证域
import "./user-auth";
// 图像后端池域
import "./image-backend-pool";
// 系统设置域
import "./system-settings";
// 存储域
import "./storage";
// 内容审核域
import "./moderation";
// 外部 API 域
import "./external-api";
// 客服支持域
import "./support";
