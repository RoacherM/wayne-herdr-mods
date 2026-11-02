/** Full-screen camera QR scanner (jsQR on video frames; iOS Safari has no BarcodeDetector). */
import jsQR from 'jsqr';

export function scanQr() {
  return new Promise((resolve, reject) => {
    if (!navigator.mediaDevices?.getUserMedia) { reject(new Error('这个浏览器不能使用相机，请粘贴配对链接')); return; }
    const overlay = document.createElement('div');
    overlay.className = 'scanner';
    overlay.innerHTML = '<video playsinline muted></video><div class="scan-frame"></div><p>对准电脑上的二维码</p><button class="btn">取消</button>';
    document.body.append(overlay);
    const video = overlay.querySelector('video');
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d', { willReadFrequently: true });
    let stream;
    let done = false;
    const finish = (value, error) => {
      if (done) return;
      done = true;
      stream?.getTracks().forEach((t) => t.stop());
      overlay.remove();
      error ? reject(error) : resolve(value);
    };
    overlay.querySelector('button').onclick = () => finish(null);
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then((s) => {
      // The user may have cancelled while the permission prompt was up; don't leave the camera on.
      if (done) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      video.srcObject = s;
      video.play().catch(() => {});
      const tick = () => {
        if (done) return;
        if (video.readyState >= 2 && video.videoWidth) {
          const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          g.drawImage(video, 0, 0, canvas.width, canvas.height);
          const code = jsQR(g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
          if (code?.data && code.data.includes('#p=')) { finish(code.data); return; }
        }
        requestAnimationFrame(tick);
      };
      tick();
    }, (error) => finish(null, new Error(error.name === 'NotAllowedError' ? '没有相机权限' : `无法打开相机：${error.message}`)));
  });
}
