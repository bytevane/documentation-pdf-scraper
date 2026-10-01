#!/usr/bin/env python3
"""
优化的PDF合并服务类 - 修复文件排序支持数字索引
"""

import os
import sys
import json
import logging
import pymupdf
from datetime import datetime
from urllib.parse import urlparse
from typing import Dict, List, Optional, Callable, Any
import gc
import psutil
import time
import traceback

class PDFMergerError(Exception):
    """PDF合并相关异常"""
    pass

class ConfigurationError(PDFMergerError):
    """配置错误异常"""
    pass

class FileProcessingError(PDFMergerError):
    """文件处理异常"""
    pass

class PDFMerger:
    """
    企业级PDF合并服务类 - 智能排序版本

    特性：
    - 智能文件排序（支持数字索引和哈希前缀）
    - 流式处理，避免内存溢出
    - 完整的错误处理和恢复机制
    - 进度跟踪和性能监控
    """

    def __init__(self, config_path: str = 'config.json', logger: Optional[logging.Logger] = None):
        """
        初始化PDF合并器

        Args:
            config_path: 配置文件路径
            logger: 可选的日志记录器
        """
        self.config_path = config_path
        self.logger = logger or self._setup_logger()

        # 加载配置
        self.config = self._load_config(config_path)

        # 设置路径
        self.pdf_dir = self.config['pdfDir']
        self.metadata_dir = os.path.join(
            self.pdf_dir,
            self.config.get('metadata', {}).get('directory', 'metadata')
        )
        self.final_pdf_dir = os.path.join(
            self.pdf_dir,
            self.config.get('output', {}).get('finalPdfDirectory', 'finalPdf')
        )

        # 性能监控
        self.stats = {
            'files_processed': 0,
            'total_pages': 0,
            'start_time': None,
            'memory_peak': 0,
            'errors': []
        }

        # 加载文章标题
        self.article_titles = self._load_article_titles()

        # 加载section结构（用于分层TOC）
        self.section_structure = self._load_section_structure()

    def _setup_logger(self) -> logging.Logger:
        """设置默认日志记录器"""
        logger = logging.getLogger('PDFMerger')
        if not logger.handlers:
            formatter = logging.Formatter(
                '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
            )

            # Console handler (stderr)
            console_handler = logging.StreamHandler()
            console_handler.setFormatter(formatter)
            logger.addHandler(console_handler)

            # File handler (logs/python_pdf_merger.log)
            try:
                log_dir = os.path.join(os.path.dirname(__file__), '..', '..', 'logs')
                os.makedirs(log_dir, exist_ok=True)
                log_file = os.path.join(log_dir, 'python_pdf_merger.log')
                file_handler = logging.FileHandler(log_file, encoding='utf-8')
                file_handler.setFormatter(formatter)
                logger.addHandler(file_handler)
            except Exception as e:
                # If file handler fails, continue with console only
                logger.warning(f"无法创建文件日志处理器: {e}")

            logger.setLevel(logging.WARNING)  # Only show warnings and errors
        return logger

    def _load_config(self, config_path: str) -> Dict[str, Any]:
        """加载配置文件"""
        try:
            if not os.path.exists(config_path):
                raise ConfigurationError(f"配置文件不存在: {config_path}")

            with open(config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)

            # 验证必需的配置项
            required_keys = ['rootURL', 'pdfDir']
            for key in required_keys:
                if key not in config:
                    raise ConfigurationError(f"缺少必需的配置项: {key}")

            return config

        except json.JSONDecodeError as e:
            raise ConfigurationError(f"配置文件JSON格式错误: {e}")
        except Exception as e:
            raise ConfigurationError(f"配置加载失败: {e}")

    def _load_article_titles(self) -> Dict[str, str]:
        with open(os.path.join(self.metadata_dir, 'articleTitles.json'), encoding='utf-8') as handle:
            titles = json.load(handle)
        if not isinstance(titles, dict) or not titles:
            raise ConfigurationError('articleTitles.json must contain article titles')
        return titles

    def _load_section_structure(self) -> Dict[str, Any]:
        with open(os.path.join(self.metadata_dir, 'sectionStructure.json'), encoding='utf-8') as handle:
            structure = json.load(handle)
        if not isinstance(structure, dict) or not isinstance(structure.get('sections'), list):
            raise ConfigurationError('sectionStructure.json must contain a sections array')
        return structure

    def _get_pdf_files(self, directory_path: str) -> List[str]:
        files = [name for name in os.listdir(directory_path)
                 if name.endswith('.pdf') and os.path.isfile(os.path.join(directory_path, name))]
        for name in files:
            prefix = name.split('-', 1)[0]
            if not prefix.isdigit():
                raise FileProcessingError(f'PDF filename must have a numeric article index: {name}')
        return sorted(files, key=lambda name: int(name.split('-', 1)[0]))

    def _create_bookmark_title(self, filename: str, article_titles: Dict[str, str]) -> str:
        index = str(int(filename.split('-', 1)[0]))
        title = article_titles.get(index)
        if not isinstance(title, str) or not title.strip():
            raise ConfigurationError(f'Missing article title for {filename}')
        return title

    def _build_hierarchical_toc(
        self,
        files: List[str],
        page_counts: Dict[str, int],
        file_to_index: Dict[str, str]
    ) -> List[List[Any]]:
        """
        构建分层TOC结构

        Args:
            files: PDF文件名列表（按合并顺序）
            page_counts: 文件名 -> 页数映射
            file_to_index: 文件名 -> 索引映射

        Returns:
            分层TOC列表 [[level, title, page, link], ...]
        """
        toc = []

        sections = self.section_structure['sections']
        current_page = 0

        # 构建文件名到页数的映射
        file_page_map = {}  # filename -> start_page
        for filename in files:
            file_page_map[filename] = current_page
            current_page += page_counts.get(filename, 0)

        # 预先构建反向索引 (index -> filename) 以避免O(n²)嵌套循环
        index_to_file = {}  # index -> filename
        for filename in files:
            file_index = file_to_index.get(filename)
            if file_index:
                index_to_file[file_index] = filename

        self.logger.debug(f"构建索引映射: {len(index_to_file)} 个文件")

        # 遍历每个section
        for section in sections:
            section_title = section['title']
            section_pages = section.get('pages', [])

            if not section_pages:
                # 跳过空section
                continue

            # 找到该section的第一个有效页面作为section链接目标
            section_start_page = None
            valid_pages = []

            for page_info in section_pages:
                page_index = page_info.get('index')
                if not page_index:
                    continue

                # O(1) 查找而不是O(n)嵌套循环
                found_file = index_to_file.get(page_index)

                if found_file and found_file in file_page_map:
                    page_start = file_page_map[found_file]
                    page_title = self.article_titles[page_index]

                    if section_start_page is None:
                        section_start_page = page_start

                    valid_pages.append({
                        'title': page_title,
                        'page': page_start,
                        'index': page_index
                    })

            # 如果该section有有效页面，添加到TOC
            if valid_pages:
                # 添加section标题（level 1）
                toc.append([
                    1,  # Level 1: Section
                    section_title,
                    section_start_page + 1,  # PyMuPDF页码从1开始
                    {"kind": 1, "page": section_start_page}
                ])

                # 添加该section下的页面（level 2）
                for page in valid_pages:
                    toc.append([
                        2,  # Level 2: Page
                        page['title'],
                        page['page'] + 1,
                        {"kind": 1, "page": page['page']}
                    ])

        self.logger.info(f"构建了分层TOC: {len([t for t in toc if t[0] == 1])} sections, {len([t for t in toc if t[0] == 2])} pages")
        return toc

    def _monitor_memory(self) -> None:
        """监控内存使用情况"""
        try:
            process = psutil.Process()
            memory_mb = process.memory_info().rss / 1024 / 1024
            self.stats['memory_peak'] = max(self.stats['memory_peak'], memory_mb)

            # 如果内存使用超过阈值，强制垃圾回收
            if memory_mb > 500:  # 500MB阈值
                gc.collect()
                self.logger.debug(f"内存使用: {memory_mb:.1f}MB, 已执行垃圾回收")
        except Exception:
            pass  # 内存监控失败不应影响主流程

    def _generate_friendly_filename(self, directory_name: str, current_date: str) -> str:
        """
        生成用户友好的PDF文件名
        
        转换规则：
        - docs.anthropic.com-docs -> Claude-Code-Docs
        - github.com-docs -> GitHub-Docs  
        - example.com-api -> Example-API
        """
        try:
            # 移除常见的域名后缀和前缀
            clean_name = directory_name
            
            # 处理 docs.anthropic.com-docs 格式
            if 'anthropic.com' in clean_name:
                clean_name = 'Claude-Code-Docs'
            elif 'github.com' in clean_name:
                clean_name = 'GitHub-Docs'
            else:
                # 通用处理：移除域名部分，只保留内容类型
                if '-' in clean_name:
                    parts = clean_name.split('-')
                    # 取最后一部分作为内容类型
                    content_type = parts[-1]
                    if '.' in parts[0]:
                        # 提取域名的主要部分
                        domain_parts = parts[0].split('.')
                        main_domain = domain_parts[-2] if len(domain_parts) > 1 else domain_parts[0]
                        clean_name = f"{main_domain.title()}-{content_type.title()}"
                    else:
                        clean_name = content_type.title()
                else:
                    clean_name = clean_name.replace('.', '-').title()
            
            return f"{clean_name}_{current_date}.pdf"
            
        except Exception as e:
            self.logger.warning(f"文件名优化失败，使用原始名称: {e}")
            return f"{directory_name}_{current_date}.pdf"

    def merge_pdfs_stream(
        self,
        directory_path: str,
        output_path: str,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> bool:
        """流式合并PDF文件"""
        try:
            files = self._get_pdf_files(directory_path)
            if not files:
                return False

            for filename in files:
                self._create_bookmark_title(filename, self.article_titles)

            merged_pdf = None
            current_file_pdf = None

            try:
                # 确保输出目录存在
                os.makedirs(os.path.dirname(output_path), exist_ok=True)

                merged_pdf = pymupdf.open()  # 创建空的PDF文档
                toc = []  # 目录结构

                # 收集信息用于构建分层TOC
                page_counts = {}  # filename -> page_count
                file_to_index = {}  # filename -> index (用于匹配sectionStructure)

                # Starting merge operation (logging reduced for cleaner output)

                for i, filename in enumerate(files):
                    try:
                        self.logger.debug(f"处理文件 {i+1}/{len(files)}: {filename}")
                        file_path = os.path.join(directory_path, filename)

                        # 检查文件是否存在
                        if not os.path.exists(file_path):
                            raise FileProcessingError(f"文件不存在: {file_path}")

                        # 打开当前PDF文件
                        current_file_pdf = pymupdf.open(file_path)
                        page_count = current_file_pdf.page_count

                        if page_count == 0:
                            raise FileProcessingError(f"空PDF文件: {filename}")

                        # 记录合并前的页数
                        start_page = merged_pdf.page_count

                        # 插入PDF页面
                        merged_pdf.insert_pdf(current_file_pdf)

                        # 记录信息用于分层TOC
                        page_counts[filename] = page_count

                        # 从文件名提取索引（支持 001-xxx.pdf 和 001-xxx_puppeteer.pdf）
                        cleaned_filename = filename
                        if '_puppeteer.pdf' in filename:
                            cleaned_filename = filename.replace('_puppeteer.pdf', '.pdf')

                        prefix = cleaned_filename.split('-')[0] if '-' in cleaned_filename else ''
                        if prefix.isdigit():
                            # 移除前导零以匹配scraper生成的索引格式
                            # "001" → "1", "000" → "0"
                            file_to_index[filename] = str(int(prefix))

                        # 创建书签（用于无分组的目录）
                        bookmark_title = self._create_bookmark_title(filename, self.article_titles)
                        toc.append([
                            1,  # 级别
                            bookmark_title,  # 标题
                            start_page + 1,  # 页码（从1开始）
                            {"kind": 1, "page": start_page}  # 链接信息
                        ])

                        # 关闭当前文件
                        current_file_pdf.close()
                        current_file_pdf = None

                        # 更新统计
                        self.stats['files_processed'] += 1
                        self.stats['total_pages'] += page_count

                        # 内存监控
                        self._monitor_memory()

                        # 进度回调
                        if progress_callback:
                            progress_callback(i + 1, len(files))

                        self.logger.debug(f"已合并: {filename} ({page_count} 页) -> 书签: {bookmark_title}")

                    except Exception as e:
                        error_msg = f"处理文件失败 {filename}: {e}"
                        self.logger.error(error_msg)
                        self.logger.error(f"错误详情: {traceback.format_exc()}")
                        self.stats['errors'].append(error_msg)

                        if current_file_pdf:
                            current_file_pdf.close()
                            current_file_pdf = None

                        raise FileProcessingError(error_msg) from e

                # Empty sections explicitly select a flat article outline.
                if self.section_structure['sections']:
                    toc = self._build_hierarchical_toc(files, page_counts, file_to_index)
                    if sum(entry[0] == 2 for entry in toc) != len(files):
                        raise ConfigurationError('Section metadata does not cover every PDF article')

                # 设置目录结构（如果启用了书签功能）
                bookmarks_enabled = self.config.get('pdf', {}).get('bookmarks', True)
                if bookmarks_enabled and toc:
                    merged_pdf.set_toc(toc)
                    self.logger.info(f"已创建PDF目录，包含 {len(toc)} 个书签")
                elif not bookmarks_enabled:
                    self.logger.info("书签功能已禁用，跳过目录创建")

                # 保存合并后的PDF
                merged_pdf.save(output_path)

                return True

            except Exception as e:
                error_msg = f"PDF合并失败: {e}"
                self.logger.error(error_msg)
                self.logger.error(f"错误详情: {traceback.format_exc()}")
                self.stats['errors'].append(error_msg)
                raise FileProcessingError(error_msg)

            finally:
                # 清理资源
                if current_file_pdf:
                    current_file_pdf.close()
                if merged_pdf:
                    merged_pdf.close()

                # 强制垃圾回收
                gc.collect()

        except Exception as e:
            self.logger.error(f"merge_pdfs_stream 执行失败: {e}")
            raise FileProcessingError(str(e)) from e

    def merge_directory(self, directory_name: Optional[str] = None) -> List[str]:
        """合并指定目录或所有子目录的PDF文件"""
        try:
            if not os.path.exists(self.pdf_dir):
                raise FileProcessingError(f"PDF目录不存在: {self.pdf_dir}")

            # 确保输出目录存在
            os.makedirs(self.final_pdf_dir, exist_ok=True)

            # 获取域名和时间戳（包含秒）
            url = urlparse(self.config['rootURL'])
            domain = url.hostname.replace('.', '_') if url.hostname else 'unknown'
            current_date = datetime.now().strftime('%Y%m%d_%H%M%S')

            merged_files = []

            if directory_name:
                # 合并指定目录
                directory_path = os.path.join(self.pdf_dir, directory_name)
                if os.path.isdir(directory_path):
                    # 单引擎模式：正常合并
                    friendly_filename = self._generate_friendly_filename(directory_name, current_date)
                    output_path = os.path.join(
                        self.final_pdf_dir,
                        friendly_filename
                    )
                    if self.merge_pdfs_stream(directory_path, output_path):
                        merged_files.append(output_path)
                else:
                    self.logger.warning(f"指定目录不存在: {directory_path}")
            else:
                # 首先合并根目录
                # 单引擎模式：正常合并
                root_output_path = os.path.join(
                    self.final_pdf_dir,
                    f"{domain}_{current_date}.pdf"
                )
                if self.merge_pdfs_stream(self.pdf_dir, root_output_path):
                    merged_files.append(root_output_path)

                # 然后合并所有子目录
                try:
                    items = os.listdir(self.pdf_dir)
                    self.logger.debug(f"PDF目录中的所有项目: {items}")

                    for item in items:
                        try:
                            item_path = os.path.join(self.pdf_dir, item)

                            # 跳过非目录和特殊目录
                            if not os.path.isdir(item_path) or item.startswith('finalPdf') or item in [os.path.basename(self.final_pdf_dir), os.path.basename(self.metadata_dir), '.temp']:
                                self.logger.debug(f"跳过项目: {item} (非目录或特殊目录)")
                                continue

                            pass  # Processing subdirectory silently
                            
                            # 单引擎模式：正常合并
                            output_path = os.path.join(
                                self.final_pdf_dir,
                                f"{item}_{current_date}.pdf"
                            )
                            if self.merge_pdfs_stream(item_path, output_path):
                                merged_files.append(output_path)

                        except Exception as e:
                            self.logger.error(f"处理子目录 {item} 时出错: {e}")
                            self.logger.error(f"错误详情: {traceback.format_exc()}")
                            raise

                except Exception as e:
                    self.logger.error(f"列出PDF目录内容时出错: {e}")
                    raise

            return merged_files

        except Exception as e:
            error_msg = f"目录合并失败: {e}"
            self.logger.error(error_msg)
            self.logger.error(f"错误详情: {traceback.format_exc()}")
            raise FileProcessingError(error_msg)

    def get_statistics(self) -> Dict[str, Any]:
        """获取合并统计信息"""
        elapsed_time = 0
        if self.stats['start_time']:
            elapsed_time = time.time() - self.stats['start_time']

        return {
            'files_processed': self.stats['files_processed'],
            'total_pages': self.stats['total_pages'],
            'elapsed_time': elapsed_time,
            'memory_peak_mb': self.stats['memory_peak'],
            'errors_count': len(self.stats['errors']),
            'errors': self.stats['errors'][-10:],  # 最近10个错误
            'avg_pages_per_file': (
                self.stats['total_pages'] / self.stats['files_processed']
                if self.stats['files_processed'] > 0 else 0
            ),
            'processing_speed': (
                self.stats['files_processed'] / elapsed_time
                if elapsed_time > 0 else 0
            )
        }

    def run(self) -> Dict[str, Any]:
        """运行PDF合并任务"""
        self.stats['start_time'] = time.time()

        try:
            # 执行合并
            merged_files = self.merge_directory()

            # 获取统计信息
            stats = self.get_statistics()

            result = {
                'success': True,
                'merged_files': merged_files,
                'statistics': stats
            }

            # Task completed successfully (detailed stats printed separately)

            return result

        except Exception as e:
            error_msg = f"PDF合并任务失败: {e}"
            self.logger.error(error_msg)
            self.logger.error(f"错误详情: {traceback.format_exc()}")

            return {
                'success': False,
                'error': error_msg,
                'statistics': self.get_statistics()
            }

def main():
    """主函数，支持命令行执行"""
    import sys
    import argparse

    parser = argparse.ArgumentParser(description='Smart PDF Merger Tool')
    parser.add_argument('--config', default='config.json', help='Configuration file path')
    parser.add_argument('--directory', help='Specify directory name to merge')
    parser.add_argument('--verbose', '-v', action='store_true', help='Verbose output')

    args = parser.parse_args()

    # 设置日志级别
    if args.verbose:
        logging.basicConfig(level=logging.INFO)
    else:
        logging.basicConfig(level=logging.WARNING)

    try:
        # 创建PDF合并器
        merger = PDFMerger(config_path=args.config)

        # 执行合并
        if args.directory:
            merged_files = merger.merge_directory(args.directory)
        else:
            result = merger.run()
            merged_files = result.get('merged_files', [])

        stats = merger.get_statistics()
        if not merged_files or stats['errors_count'] > 0:
            raise RuntimeError('PDF merge did not complete successfully')

        # Output results
        print(f"\n✅ Merge completed! Generated {len(merged_files)} PDF file(s):")
        for file_path in merged_files:
            print(f"  📄 {file_path}")

        # Output statistics
        print(f"\n📊 Statistics:")
        print(f"  - Files processed: {stats['files_processed']}")
        print(f"  - Total pages: {stats['total_pages']}")
        print(f"  - Duration: {stats['elapsed_time']:.1f} seconds")
        print(f"  - Memory peak: {stats['memory_peak_mb']:.1f} MB")

        if stats['errors_count'] > 0:
            print(f"  ⚠️  Errors: {stats['errors_count']}")

        print(json.dumps({
            'success': True,
            'mergedFiles': [str(file_path) for file_path in merged_files],
            'filesProcessed': stats['files_processed'],
            'totalPages': stats['total_pages'],
        }))
        return 0

    except Exception as e:
        print(f"❌ Execution failed: {e}", file=sys.stderr)
        print(f"Error details: {traceback.format_exc()}", file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())
