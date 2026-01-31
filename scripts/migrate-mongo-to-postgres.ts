import { getDb } from "../lib/mongo";
import sql from "../lib/db/postgres";

interface MigrationStats {
  users: { total: number; migrated: number; failed: number };
  shops: { total: number; migrated: number; failed: number };
  enterprises: { total: number; migrated: number; failed: number };
  sessions: { total: number; migrated: number; failed: number };
  auditLogs: { total: number; migrated: number; failed: number };
  notifications: { total: number; migrated: number; failed: number };
  announcements: { total: number; migrated: number; failed: number };
  knowledgeArticles: { total: number; migrated: number; failed: number };
  supportChatSessions: { total: number; migrated: number; failed: number };
}

const stats: MigrationStats = {
  users: { total: 0, migrated: 0, failed: 0 },
  shops: { total: 0, migrated: 0, failed: 0 },
  enterprises: { total: 0, migrated: 0, failed: 0 },
  sessions: { total: 0, migrated: 0, failed: 0 },
  auditLogs: { total: 0, migrated: 0, failed: 0 },
  notifications: { total: 0, migrated: 0, failed: 0 },
  announcements: { total: 0, migrated: 0, failed: 0 },
  knowledgeArticles: { total: 0, migrated: 0, failed: 0 },
  supportChatSessions: { total: 0, migrated: 0, failed: 0 },
};

async function migrateUsers(db: any) {
  console.log("\n=== Migrating Users ===");
  const users = await db.collection("users").find({}).toArray();
  stats.users.total = users.length;

  for (const user of users) {
    try {
      await sql`
        INSERT INTO users (id, email, password_hash, role, name, shop_ids, enterprise_id, preferences, created_at, updated_at)
        VALUES (
          gen_random_uuid(),
          ${user.email},
          ${user.passwordHash || user.password || ""},
          ${user.role || "user"},
          ${user.name || ""},
          ${JSON.stringify(user.shopIds || [])}::jsonb,
          ${user.enterpriseId || null},
          ${JSON.stringify(user.preferences || {})}::jsonb,
          ${user.createdAt ? new Date(user.createdAt) : new Date()},
          ${user.updatedAt ? new Date(user.updatedAt) : new Date()}
        )
        ON CONFLICT (email) DO NOTHING
      `;
      stats.users.migrated++;
    } catch (error) {
      console.error(`Failed to migrate user ${user.email}:`, error);
      stats.users.failed++;
    }
  }
  console.log(`Users: ${stats.users.migrated}/${stats.users.total} migrated, ${stats.users.failed} failed`);
}

async function migrateEnterprises(db: any) {
  console.log("\n=== Migrating Enterprises ===");
  const enterprises = await db.collection("enterprise_accounts").find({}).toArray();
  stats.enterprises.total = enterprises.length;

  for (const enterprise of enterprises) {
    try {
      await sql`
        INSERT INTO enterprises (id, name, settings, created_at, updated_at)
        VALUES (
          gen_random_uuid(),
          ${enterprise.name || ""},
          ${JSON.stringify({
            featureSettings: enterprise.featureSettings || {},
            ...enterprise.settings,
          })}::jsonb,
          ${enterprise.createdAt ? new Date(enterprise.createdAt) : new Date()},
          ${enterprise.updatedAt ? new Date(enterprise.updatedAt) : new Date()}
        )
        ON CONFLICT DO NOTHING
      `;
      stats.enterprises.migrated++;
    } catch (error) {
      console.error(`Failed to migrate enterprise ${enterprise.name}:`, error);
      stats.enterprises.failed++;
    }
  }
  console.log(`Enterprises: ${stats.enterprises.migrated}/${stats.enterprises.total} migrated, ${stats.enterprises.failed} failed`);
}

async function migrateShops(db: any) {
  console.log("\n=== Migrating Shops ===");
  const shops = await db.collection("shops").find({}).toArray();
  stats.shops.total = shops.length;

  for (const shop of shops) {
    try {
      const settings = {
        featureSettings: shop.featureSettings || {},
        integrationSettings: shop.integrationSettings || {},
        oilStickerSettings: shop.oilStickerSettings || {},
        keytagSettings: shop.keytagSettings || {},
        ...shop.settings,
      };

      const billing = {
        plan: shop.billingPlan || shop.billing?.plan || "trial",
        stripeCustomerId: shop.stripeCustomerId || shop.billing?.stripeCustomerId,
        stripeSubscriptionId: shop.stripeSubscriptionId || shop.billing?.stripeSubscriptionId,
        billingEmail: shop.billingEmail || shop.billing?.billingEmail,
        trialEndsAt: shop.trialEndsAt || shop.billing?.trialEndsAt,
        subscriptionStatus: shop.subscriptionStatus || shop.billing?.subscriptionStatus || "active",
        gracePeriodEndsAt: shop.gracePeriodEndsAt || shop.billing?.gracePeriodEndsAt,
        ...shop.billing,
      };

      await sql`
        INSERT INTO shops (id, name, enterprise_id, owner_id, settings, billing, created_at, updated_at)
        VALUES (
          ${shop._id?.toString() || shop.id},
          ${shop.name || ""},
          ${shop.enterpriseId || null},
          ${shop.ownerId || null},
          ${JSON.stringify(settings)}::jsonb,
          ${JSON.stringify(billing)}::jsonb,
          ${shop.createdAt ? new Date(shop.createdAt) : new Date()},
          ${shop.updatedAt ? new Date(shop.updatedAt) : new Date()}
        )
        ON CONFLICT (id) DO UPDATE SET
          settings = EXCLUDED.settings,
          billing = EXCLUDED.billing,
          updated_at = NOW()
      `;
      stats.shops.migrated++;
    } catch (error) {
      console.error(`Failed to migrate shop ${shop.name}:`, error);
      stats.shops.failed++;
    }
  }
  console.log(`Shops: ${stats.shops.migrated}/${stats.shops.total} migrated, ${stats.shops.failed} failed`);
}

async function migrateSessions(db: any) {
  console.log("\n=== Migrating Sessions ===");
  const sessions = await db.collection("sessions").find({}).toArray();
  stats.sessions.total = sessions.length;

  for (const session of sessions) {
    try {
      const usersResult = await sql`SELECT id FROM users WHERE email = ${session.email} LIMIT 1`;
      const userId = usersResult[0]?.id;
      if (!userId) {
        stats.sessions.failed++;
        continue;
      }

      await sql`
        INSERT INTO sessions (id, user_id, token, expires_at, created_at)
        VALUES (
          gen_random_uuid(),
          ${userId}::uuid,
          ${session.token || ""},
          ${session.expiresAt ? new Date(session.expiresAt) : new Date(Date.now() + 86400000)},
          ${session.createdAt ? new Date(session.createdAt) : new Date()}
        )
        ON CONFLICT DO NOTHING
      `;
      stats.sessions.migrated++;
    } catch (error) {
      console.error(`Failed to migrate session:`, error);
      stats.sessions.failed++;
    }
  }
  console.log(`Sessions: ${stats.sessions.migrated}/${stats.sessions.total} migrated, ${stats.sessions.failed} failed`);
}

async function migrateAuditLogs(db: any) {
  console.log("\n=== Migrating Audit Logs ===");
  const logs = await db.collection("admin_audit_log").find({}).toArray();
  stats.auditLogs.total = logs.length;

  for (const log of logs) {
    try {
      await sql`
        INSERT INTO admin_audit_logs (admin_email, action, target_type, target_id, details, ip_address, created_at)
        VALUES (
          ${log.adminEmail || log.email || ""},
          ${log.action || ""},
          ${log.targetType || ""},
          ${log.targetId || ""},
          ${JSON.stringify(log.details || {})}::jsonb,
          ${log.ipAddress || null},
          ${log.timestamp ? new Date(log.timestamp) : new Date()}
        )
      `;
      stats.auditLogs.migrated++;
    } catch (error) {
      console.error(`Failed to migrate audit log:`, error);
      stats.auditLogs.failed++;
    }
  }
  console.log(`Audit Logs: ${stats.auditLogs.migrated}/${stats.auditLogs.total} migrated, ${stats.auditLogs.failed} failed`);
}

async function migrateNotifications(db: any) {
  console.log("\n=== Migrating Notifications ===");
  const notifications = await db.collection("notifications").find({}).toArray();
  stats.notifications.total = notifications.length;

  for (const notification of notifications) {
    try {
      let userId = notification.userId;
      if (userId && userId.includes("@")) {
        const usersResult = await sql`SELECT id FROM users WHERE email = ${userId} LIMIT 1`;
        userId = usersResult[0]?.id;
      }
      if (!userId) {
        stats.notifications.failed++;
        continue;
      }

      await sql`
        INSERT INTO notifications (user_id, shop_id, type, title, message, link, is_read, metadata, created_at)
        VALUES (
          ${userId}::uuid,
          ${notification.shopId || null},
          ${notification.type || "info"},
          ${notification.title || ""},
          ${notification.message || ""},
          ${notification.link || null},
          ${notification.isRead || false},
          ${JSON.stringify(notification.metadata || {})}::jsonb,
          ${notification.createdAt ? new Date(notification.createdAt) : new Date()}
        )
      `;
      stats.notifications.migrated++;
    } catch (error) {
      console.error(`Failed to migrate notification:`, error);
      stats.notifications.failed++;
    }
  }
  console.log(`Notifications: ${stats.notifications.migrated}/${stats.notifications.total} migrated, ${stats.notifications.failed} failed`);
}

async function migrateAnnouncements(db: any) {
  console.log("\n=== Migrating Announcements ===");
  const announcements = await db.collection("announcements").find({}).toArray();
  stats.announcements.total = announcements.length;

  for (const announcement of announcements) {
    try {
      await sql`
        INSERT INTO system_announcements (title, content, type, priority, target_audience, is_active, starts_at, ends_at, created_by, created_at, updated_at)
        VALUES (
          ${announcement.title || ""},
          ${announcement.content || ""},
          ${announcement.type || "info"},
          ${announcement.priority || 0},
          ${JSON.stringify(announcement.targetAudience || [])}::jsonb,
          ${announcement.isActive !== false},
          ${announcement.startsAt ? new Date(announcement.startsAt) : new Date()},
          ${announcement.endsAt ? new Date(announcement.endsAt) : null},
          ${announcement.createdBy || null},
          ${announcement.createdAt ? new Date(announcement.createdAt) : new Date()},
          ${announcement.updatedAt ? new Date(announcement.updatedAt) : new Date()}
        )
      `;
      stats.announcements.migrated++;
    } catch (error) {
      console.error(`Failed to migrate announcement ${announcement.title}:`, error);
      stats.announcements.failed++;
    }
  }
  console.log(`Announcements: ${stats.announcements.migrated}/${stats.announcements.total} migrated, ${stats.announcements.failed} failed`);
}

async function migrateKnowledgeArticles(db: any) {
  console.log("\n=== Migrating Knowledge Articles ===");
  const articles = await db.collection("knowledge_base").find({}).toArray();
  stats.knowledgeArticles.total = articles.length;

  for (const article of articles) {
    try {
      await sql`
        INSERT INTO knowledge_articles (title, content, category, tags, is_published, created_by, created_at, updated_at)
        VALUES (
          ${article.title || ""},
          ${article.content || ""},
          ${article.category || "general"},
          ${JSON.stringify(article.tags || [])}::jsonb,
          ${article.isPublished !== false},
          ${article.createdBy || null},
          ${article.createdAt ? new Date(article.createdAt) : new Date()},
          ${article.updatedAt ? new Date(article.updatedAt) : new Date()}
        )
      `;
      stats.knowledgeArticles.migrated++;
    } catch (error) {
      console.error(`Failed to migrate knowledge article ${article.title}:`, error);
      stats.knowledgeArticles.failed++;
    }
  }
  console.log(`Knowledge Articles: ${stats.knowledgeArticles.migrated}/${stats.knowledgeArticles.total} migrated, ${stats.knowledgeArticles.failed} failed`);
}

async function migrateSupportChatSessions(db: any) {
  console.log("\n=== Migrating Support Chat Sessions ===");
  const sessions = await db.collection("support_chat_sessions").find({}).toArray();
  stats.supportChatSessions.total = sessions.length;

  for (const session of sessions) {
    try {
      let userId = session.userId;
      if (userId && userId.includes("@")) {
        const usersResult = await sql`SELECT id FROM users WHERE email = ${userId} LIMIT 1`;
        userId = usersResult[0]?.id;
      }

      await sql`
        INSERT INTO support_chat_sessions (user_id, shop_id, messages, status, escalated_to_ticket_id, created_at, updated_at)
        VALUES (
          ${userId ? `${userId}::uuid` : null},
          ${session.shopId || null},
          ${JSON.stringify(session.messages || [])}::jsonb,
          ${session.status || "active"},
          ${session.escalatedToTicketId || null},
          ${session.createdAt ? new Date(session.createdAt) : new Date()},
          ${session.updatedAt ? new Date(session.updatedAt) : new Date()}
        )
      `;
      stats.supportChatSessions.migrated++;
    } catch (error) {
      console.error(`Failed to migrate support chat session:`, error);
      stats.supportChatSessions.failed++;
    }
  }
  console.log(`Support Chat Sessions: ${stats.supportChatSessions.migrated}/${stats.supportChatSessions.total} migrated, ${stats.supportChatSessions.failed} failed`);
}

async function main() {
  console.log("==============================================");
  console.log("MongoDB to PostgreSQL Data Migration");
  console.log("==============================================");
  console.log("Starting migration at:", new Date().toISOString());

  try {
    const db = await getDb();

    await migrateEnterprises(db);
    await migrateUsers(db);
    await migrateShops(db);
    await migrateSessions(db);
    await migrateAuditLogs(db);
    await migrateNotifications(db);
    await migrateAnnouncements(db);
    await migrateKnowledgeArticles(db);
    await migrateSupportChatSessions(db);

    console.log("\n==============================================");
    console.log("Migration Summary");
    console.log("==============================================");
    console.log("Users:", stats.users);
    console.log("Enterprises:", stats.enterprises);
    console.log("Shops:", stats.shops);
    console.log("Sessions:", stats.sessions);
    console.log("Audit Logs:", stats.auditLogs);
    console.log("Notifications:", stats.notifications);
    console.log("Announcements:", stats.announcements);
    console.log("Knowledge Articles:", stats.knowledgeArticles);
    console.log("Support Chat Sessions:", stats.supportChatSessions);
    console.log("\nMigration completed at:", new Date().toISOString());
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }

  process.exit(0);
}

main();
