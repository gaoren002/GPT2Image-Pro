/** 既有独立 worker 启动入口：共享端口承载超分、修复与 ISNet 抠图，不加载模型。 */
import {
  createInferenceServer,
  workerConfig,
} from "./inference-worker-runtime.mjs";

const config = workerConfig();
const { server, shutdown } = createInferenceServer(config);
server.listen(config.port, config.bind, () => {
  console.info(
    `image worker listening port=${config.port} concurrency=${config.concurrency}`
  );
});
/** 收到停机信号立即取消任务；最后强杀仅作用于独立 worker。 */
function stop() {
  shutdown();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
