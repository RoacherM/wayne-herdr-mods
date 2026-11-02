declare module "*.svg" {
  const asset: { url: string; size: { width: number; height: number } };
  export default asset;
}
