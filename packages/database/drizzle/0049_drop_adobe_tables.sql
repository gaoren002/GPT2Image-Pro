-- 移除 Adobe 通道相关的表与列（阶段 3：Adobe 从项目彻底移除）。
-- 生产库中 image_backend_adobe / adobe_account / adobe_token 均为 0 行，
-- image_backend_api 的 adobe_sourced 列线上值恒为 false（已核实），
-- 故直接 DROP，无数据迁移需求。video_generation 已备份（生产
-- /home/user1/backup-adobe-video-drop-*.sql.gz）后由本迁移删除。
-- 注意顺序：video_generation 先删（其 adobe_id 外键引用 image_backend_adobe）。
DROP TABLE IF EXISTS video_generation;
DROP TABLE IF EXISTS adobe_token;
DROP TABLE IF EXISTS adobe_account;
DROP TABLE IF EXISTS image_backend_adobe_group;
DROP TABLE IF EXISTS image_backend_adobe;
ALTER TABLE image_backend_api DROP COLUMN IF EXISTS adobe_sourced;
ALTER TABLE image_backend_api DROP COLUMN IF EXISTS billing_multiplier;
