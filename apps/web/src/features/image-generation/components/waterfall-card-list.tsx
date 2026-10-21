"use client";

/**
 * 瀑布流卡片列表(叶子订阅组件)。
 *
 * 职责:订阅 batchCards(流式期间逐帧更新:卡片 imageUrl、streamText 等),
 * 把瀑布流列表的渲染隔离在本文内;create-page-client 父组件不再订阅
 * batchCards,生成期间不随流式帧全量重渲。单卡渲染经 renderCard 注入,
 * 必须为 useCallback 固定引用。
 */

import { useCreateRuntimeState } from "@/features/image-generation/create-runtime-store";
import type { BatchCard } from "./chat-message-types";

export function WaterfallCardList({
  renderCard,
}: {
  renderCard: (card: BatchCard) => React.ReactNode;
}) {
  const [batchCards] = useCreateRuntimeState<BatchCard[]>("batchCards", []);
  return (
    <div className="columns-1 gap-3 sm:columns-2 lg:columns-3">
      {batchCards.map((card) => renderCard(card))}
    </div>
  );
}
