/**
 * MongoDB 管理器
 * 处理用户ID映射和KOC数据持久化
 */
import { MongoClient, ObjectId } from 'mongodb';

class MongoDBManager {
  constructor() {
    this.client = null;
    this.db = null;
    this.initialized = false;
  }

  async connect() {
    if (this.client && this.client.topology?.isConnected()) {
      return;
    }

    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/koc-discovery';

    try {
      this.client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      });

      await this.client.connect();
      this.db = this.client.db();

      // 测试连接
      await this.db.admin().ping();

      console.log('[MongoDB] 连接成功');

      if (process.env.MONGODB_AUTO_INIT === 'true') {
        await this.initCollections();
      }

      this.initialized = true;
    } catch (err) {
      console.warn('[MongoDB] 连接失败:', err.message);
      throw err;
    }
  }

  async initCollections() {
    try {
      // 创建 users 集合和索引
      const usersCollection = this.db.collection('users');

      await usersCollection.createIndex({ internalId: 1 }, { unique: true }).catch(() => {});
      await usersCollection.createIndex({ 'platforms.xiaohongshu.userId': 1 }).catch(() => {});
      await usersCollection.createIndex({ createdAt: 1 }).catch(() => {});

      console.log('[MongoDB] users 集合初始化完成');

      // 创建 koc_records 集合和索引
      const recordsCollection = this.db.collection('koc_records');

      await recordsCollection.createIndex({ userId: 1, platform: 1, createdAt: -1 }).catch(() => {});
      await recordsCollection.createIndex({ platformUserId: 1 }).catch(() => {});
      await recordsCollection.createIndex({ createdAt: 1 }).catch(() => {});

      console.log('[MongoDB] koc_records 集合初始化完成');
    } catch (err) {
      console.warn('[MongoDB] 初始化集合失败:', err.message);
    }
  }

  /**
   * 获取或创建用户
   * @param {string} platform - 平台名称 (xiaohongshu, youtube, douyin, tiktok)
   * @param {string} platformUserId - 平台用户ID
   * @param {object} data - 用户数据 { redId, nickname, avatar, ... }
   * @returns {Promise<object>} 用户文档
   */
  async upsertUser(platform, platformUserId, data = {}) {
    if (!this.initialized) {
      throw new Error('MongoDB 未初始化');
    }

    const internalId = `usr_${platform}_${platformUserId}`;

    try {
      const result = await this.db.collection('users').findOneAndUpdate(
        { internalId },
        {
          $set: {
            [`platforms.${platform}`]: {
              userId: platformUserId,
              redId: data.redId || '',
              nickname: data.nickname || '',
              avatar: data.avatar || '',
              discoveredAt: new Date(),
              lastUpdated: new Date(),
            },
            updatedAt: new Date(),
          },
          $setOnInsert: {
            internalId,
            profile: {
              nickname: data.nickname || '',
              avatar: data.avatar || '',
              description: data.description || '',
              primaryPlatform: platform,
            },
            createdAt: new Date(),
            updatedAt: new Date(),
            tags: [],
            searchCount: 0,
          },
        },
        { upsert: true, returnDocument: 'after' }
      );

      return result.value;
    } catch (err) {
      console.warn('[MongoDB] upsertUser 失败:', err.message);
      throw err;
    }
  }

  /**
   * 保存KOC记录
   * @param {string} userId - 内部用户ID（MongoDB _id）
   * @param {string} platform - 平台名称
   * @param {string} platformUserId - 平台用户ID
   * @param {object} snapshot - 搜索快照数据
   * @param {object} evaluation - 评分数据
   */
  async saveKocRecord(userId, platform, platformUserId, snapshot = {}, evaluation = {}) {
    if (!this.initialized) {
      throw new Error('MongoDB 未初始化');
    }

    try {
      await this.db.collection('koc_records').insertOne({
        userId: new ObjectId(userId),
        platform,
        platformUserId,
        snapshot: {
          keyword: snapshot.keyword || '',
          followers: snapshot.followers || 0,
          likes: snapshot.likes || 0,
          posts: snapshot.posts || 0,
          engagement: snapshot.engagement || 0,
          timestamp: new Date(),
          ...snapshot,
        },
        evaluation: {
          totalScore: evaluation.totalScore || 0,
          grade: evaluation.grade || 'N/A',
          confidence: evaluation.confidence || 0,
          ...evaluation,
        },
        createdAt: new Date(),
      });
    } catch (err) {
      console.warn('[MongoDB] saveKocRecord 失败:', err.message);
      throw err;
    }
  }

  /**
   * 查询用户的历史KOC记录
   * @param {string} internalId - 内部用户ID
   * @param {number} limit - 限制数量
   */
  async getKocHistory(internalId, limit = 10) {
    if (!this.initialized) {
      throw new Error('MongoDB 未初始化');
    }

    try {
      const user = await this.db.collection('users').findOne({ internalId });
      if (!user) return [];

      const records = await this.db
        .collection('koc_records')
        .find({ userId: user._id })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

      return records;
    } catch (err) {
      console.warn('[MongoDB] getKocHistory 失败:', err.message);
      return [];
    }
  }

  /**
   * 检查MongoDB连接状态
   */
  isConnected() {
    return this.initialized && this.client?.topology?.isConnected();
  }

  async close() {
    if (this.client) {
      await this.client.close();
      this.initialized = false;
      console.log('[MongoDB] 连接已关闭');
    }
  }
}

// 单例模式
const mongoDBManager = new MongoDBManager();

export default mongoDBManager;
