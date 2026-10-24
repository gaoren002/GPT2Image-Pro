/** 升级预留生产入口：事务外费率准备，事务内纯报价和 PostgreSQL store，无嵌套事务。 */
import { prepareUpgradeQuote } from "./prepare-upgrade-quote";
import { createUpgradeReservationService } from "./upgrade-reservation-service";
import { upgradeStore } from "./upgrade-reservation-store";

export const upgradeReservations = createUpgradeReservationService(
  upgradeStore,
  prepareUpgradeQuote
);
/** 已验签回调的事务入口；迟到付款持久化待退款，不读取运行时价格。 */
export const settleUpgradePayment = upgradeReservations.settle;
