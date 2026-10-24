/** 协议测试专用子进程；不加载模型、不处理真实内容。 */
process.on("message", ({ operation, image }) => {
  if (operation === "hold") return;
  const output =
    operation === "environment"
      ? Buffer.from(JSON.stringify(Object.keys(process.env).sort()))
      : image;
  process.send({ output });
});
