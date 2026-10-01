// src/services/metadataService.js
export class MetadataService {
  constructor(fileService, pathService, logger) {
    this.fileService = fileService;
    this.pathService = pathService;
    this.logger = logger;
  }

  /**
   * 保存文章标题
   */
  async saveArticleTitle(index, title) {
    const filePath = this.pathService.getMetadataPath('articleTitles');
    await this.fileService.updateJson(
      filePath,
      {},
      (titles) => {
        titles[index] = title;
        return titles;
      },
      { recoverInvalidJson: true }
    );
    this.logger.info(`保存文章标题: [${index}] ${title}`);
  }

  /**
   * 获取所有文章标题
   */
  async getArticleTitles() {
    const filePath = this.pathService.getMetadataPath('articleTitles');
    return await this.fileService.readJson(filePath, {});
  }

  async resetArticleTitles() {
    await this.fileService.writeJson(this.pathService.getMetadataPath('articleTitles'), {});
  }

  /**
   * 保存section结构信息（用于生成分层TOC）
   */
  async saveSectionStructure(structure) {
    const filePath = this.pathService.getMetadataPath('sectionStructure');
    await this.fileService.writeJson(filePath, structure);
    this.logger.debug(`保存section结构: ${structure.sections?.length || 0} sections`);
  }

  /**
   * 获取section结构信息
   */
  async getSectionStructure() {
    const filePath = this.pathService.getMetadataPath('sectionStructure');
    return await this.fileService.readJson(filePath, null);
  }

  /**
   * 记录图片加载失败
   */
  async logImageLoadFailure(url, index) {
    const filePath = this.pathService.getMetadataPath('imageLoadFailures');
    const failures = await this.fileService.readJson(filePath, []);

    // 检查是否已存在
    const exists = failures.some((f) => f.url === url && f.index === index);
    if (!exists) {
      failures.push({
        url,
        index,
        timestamp: new Date().toISOString(),
      });
      await this.fileService.writeJson(filePath, failures);
      this.logger.warn(`记录图片加载失败: ${url}`);
    }
  }

}
