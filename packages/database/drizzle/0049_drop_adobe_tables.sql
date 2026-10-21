-- 移除 Adobe 通道相关的表与列（阶段 3：Adobe 从项目彻底移除）。
-- 生产库中 image_backend_adobe / adobe_account / adobe_token 均为 0 行，
-- image_backend_api 的 adobe_sourced 列线上值恒为 false（已核实），
-- 故直接 DROP，无数据迁移需求。video_generation 已在 0048 前的备份流程
-- 导出后由本迁移一并删除（阶段 2 决定：视频历史备份后彻底删表）。
DROP TABLE IF EXISTS adobe_token;
DROP TABLE IF EXISTS adobe_account;
DROP TABLE IF EXISTS image_backend_adobe_group;
DROP TABLE IF EXISTS image_backend_adobe;
DROP TABLE IF EXISTS video_generation;
ALTER TABLE image_backend_api DROP COLUMN IF EXISTS adobe_sourced;
ALTER TABLE image_backend_api DROP COLUMN IF EXISTS billing_multiplier;
