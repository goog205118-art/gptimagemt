export function storageFailureMessage(error) {
  const name = error?.name || 'UnknownError';
  if (name === 'QuotaExceededError')
    return '本地保存失败：浏览器存储额度不足。请先下载图片或导出备份，再清理不需要的记录。';
  if (['NotReadableError', 'NotFoundError'].includes(name))
    return '本地保存失败：有图片的原始文件已失效或无法读取。请重新添加受影响的参考图；当前页面仍可下载的图片请先保存。';
  if (name === 'DataCloneError')
    return '本地保存失败：部分图片或记录无法写入浏览器数据库。请先保存重要图片；这不代表空间不足。';
  if (['SecurityError', 'NotAllowedError'].includes(name))
    return '本地保存失败：浏览器拒绝访问本站存储。请检查是否限制了网站数据保存。';
  if (name === 'InvalidStateError')
    return '本地保存失败：本站数据库连接已关闭。请先保存重要图片，再重新打开页面。';
  return '本地保存失败：浏览器数据库写入异常，尚不能认定为空间不足。请先下载重要图片或导出备份。';
}
