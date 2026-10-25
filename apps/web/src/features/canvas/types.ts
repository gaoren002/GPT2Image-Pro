/** 画布与图库之间的轻量传输类型；不引入编辑器或服务端依赖。 */
export type CanvasImageSource = {
  id: string;
  prompt: string;
  url: string;
  thumbnailUrl: string;
};

export type CanvasEditorProps = {
  userId: string;
  images: CanvasImageSource[];
  onRefreshImages: () => Promise<void>;
  onContinueEditing: (image: Blob) => Promise<void>;
};
