import sql from "@/lib/db/postgres";
import { createNotificationsForUsers } from "@/lib/notifications";

export type AnnouncementPriority = "info" | "warning" | "critical";
export type AnnouncementStatus = "draft" | "sent" | "scheduled";
export type TargetType = "all" | "shops" | "roles" | "sms_integration";
export type SMSIntegrationType = "tekmetric" | "protractor" | "autoflow" | "shopware" | "shopmonkey";

export interface AnnouncementTarget {
  type: TargetType;
  shopIds?: number[];
  roles?: string[];
  smsIntegrations?: SMSIntegrationType[];
}

export interface Announcement {
  id?: number;
  title: string;
  message: string;
  priority: AnnouncementPriority;
  target: AnnouncementTarget;
  deliveryChannels: {
    inApp: boolean;
    email: boolean;
  };
  status: AnnouncementStatus;
  createdBy: string;
  createdAt: Date;
  sentAt?: Date;
  expiresAt?: Date;
  scheduledAt?: Date;
  stats?: {
    totalRecipients: number;
    emailsSent: number;
    inAppSent: number;
  };
}

export interface AnnouncementRecipient {
  email: string;
  userId: string;
  shopId?: number;
  shopName?: string;
}

export async function createAnnouncement(
  announcement: Omit<Announcement, "id" | "createdAt" | "stats">
): Promise<number | null> {
  try {
    const result = await sql`
      INSERT INTO system_announcements (
        title, message, priority, target_audience, delivery_channels, 
        status, scheduled_at, expires_at, created_by, stats
      )
      VALUES (
        ${announcement.title}, 
        ${announcement.message}, 
        ${announcement.priority}, 
        ${JSON.stringify(announcement.target)}, 
        ${JSON.stringify(announcement.deliveryChannels)}, 
        ${announcement.status}, 
        ${announcement.scheduledAt || null}, 
        ${announcement.expiresAt || null}, 
        ${announcement.createdBy},
        '{"totalRecipients": 0, "emailsSent": 0, "inAppSent": 0}'::jsonb
      )
      RETURNING id
    `;
    return result[0]?.id || null;
  } catch (error) {
    console.error("Error creating announcement:", error);
    return null;
  }
}

export async function getAnnouncements(
  limit: number = 50,
  status?: AnnouncementStatus
): Promise<Announcement[]> {
  try {
    let results;
    if (status) {
      results = await sql`
        SELECT id, title, message, priority, target_audience as target, 
               delivery_channels as "deliveryChannels", status, 
               scheduled_at as "scheduledAt", sent_at as "sentAt", 
               expires_at as "expiresAt", created_by as "createdBy", 
               stats, created_at as "createdAt"
        FROM system_announcements 
        WHERE status = ${status}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else {
      results = await sql`
        SELECT id, title, message, priority, target_audience as target, 
               delivery_channels as "deliveryChannels", status, 
               scheduled_at as "scheduledAt", sent_at as "sentAt", 
               expires_at as "expiresAt", created_by as "createdBy", 
               stats, created_at as "createdAt"
        FROM system_announcements 
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    }
    return results as unknown as Announcement[];
  } catch (error) {
    console.error("Error fetching announcements:", error);
    return [];
  }
}

export async function getAnnouncementById(id: string): Promise<Announcement | null> {
  try {
    const results = await sql`
      SELECT id, title, message, priority, target_audience as target, 
             delivery_channels as "deliveryChannels", status, 
             scheduled_at as "scheduledAt", sent_at as "sentAt", 
             expires_at as "expiresAt", created_by as "createdBy", 
             stats, created_at as "createdAt"
      FROM system_announcements 
      WHERE id = ${Number(id)}
      LIMIT 1
    `;
    return results[0] as unknown as Announcement || null;
  } catch (error) {
    console.error("Error fetching announcement:", error);
    return null;
  }
}

export async function getTargetedUsers(target: AnnouncementTarget): Promise<AnnouncementRecipient[]> {
  try {
    const recipients: AnnouncementRecipient[] = [];

    if (target.type === "all") {
      const users = await sql`
        SELECT id, email, shop_id FROM users WHERE email IS NOT NULL
      `;
      for (const user of users) {
        recipients.push({
          email: user.email as string,
          userId: String(user.id),
          shopId: user.shop_id ? Number(user.shop_id) : undefined,
        });
      }
    } else if (target.type === "shops" && target.shopIds?.length) {
      const shopIdStrings = target.shopIds.map(String);
      const users = await sql`
        SELECT id, email, shop_id FROM users 
        WHERE email IS NOT NULL AND shop_id = ANY(${shopIdStrings})
      `;
      for (const user of users) {
        recipients.push({
          email: user.email as string,
          userId: String(user.id),
          shopId: user.shop_id ? Number(user.shop_id) : undefined,
        });
      }
    } else if (target.type === "roles" && target.roles?.length) {
      const users = await sql`
        SELECT id, email, shop_id FROM users 
        WHERE email IS NOT NULL AND role = ANY(${target.roles})
      `;
      for (const user of users) {
        recipients.push({
          email: user.email as string,
          userId: String(user.id),
          shopId: user.shop_id ? Number(user.shop_id) : undefined,
        });
      }
    } else if (target.type === "sms_integration" && target.smsIntegrations?.length) {
      const shops = await sql`
        SELECT shop_id, name, tekmetric, protractor, autoflow 
        FROM shops 
        WHERE is_active = TRUE
      `;
      
      const matchingShops = shops.filter((shop: Record<string, unknown>) => {
        for (const sms of target.smsIntegrations!) {
          if (sms === "tekmetric" && shop.tekmetric) return true;
          if (sms === "protractor" && shop.protractor) return true;
          if (sms === "autoflow" && shop.autoflow) return true;
        }
        return false;
      });

      const shopIdStrings = matchingShops.map((s: Record<string, unknown>) => String(s.shop_id));
      const shopNameMap = new Map(matchingShops.map((s: Record<string, unknown>) => [String(s.shop_id), s.name]));

      if (shopIdStrings.length > 0) {
        const users = await sql`
          SELECT id, email, shop_id FROM users 
          WHERE email IS NOT NULL AND shop_id = ANY(${shopIdStrings})
        `;
        for (const user of users) {
          recipients.push({
            email: user.email as string,
            userId: String(user.id),
            shopId: user.shop_id ? Number(user.shop_id) : undefined,
            shopName: shopNameMap.get(String(user.shop_id)) as string | undefined,
          });
        }
      }
    }

    const uniqueRecipients = Array.from(
      new Map(recipients.map((r) => [r.userId, r])).values()
    );

    return uniqueRecipients;
  } catch (error) {
    console.error("Error getting targeted users:", error);
    return [];
  }
}

export async function sendAnnouncement(
  announcementId: string
): Promise<{ success: boolean; stats?: Announcement["stats"]; error?: string }> {
  try {
    const announcement = await getAnnouncementById(announcementId);

    if (!announcement) {
      return { success: false, error: "Announcement not found" };
    }

    if (announcement.status === "sent") {
      return { success: false, error: "Announcement already sent" };
    }

    const recipients = await getTargetedUsers(announcement.target);

    if (recipients.length === 0) {
      return { success: false, error: "No recipients found for target criteria" };
    }

    let inAppSent = 0;
    let emailsSent = 0;

    if (announcement.deliveryChannels.inApp) {
      const userIds = recipients.map((r) => r.userId);
      inAppSent = await createNotificationsForUsers(userIds, {
        type: "system",
        title: announcement.title,
        message: announcement.message,
        shopId: undefined,
        metadata: {
          announcementId: announcementId,
          priority: announcement.priority,
        },
      });
    }

    if (announcement.deliveryChannels.email) {
      const { sendAnnouncementEmails } = await import("@/lib/email");
      emailsSent = await sendAnnouncementEmails(
        recipients.map((r) => r.email),
        announcement.title,
        announcement.message,
        announcement.priority
      );
    }

    const stats = {
      totalRecipients: recipients.length,
      inAppSent,
      emailsSent,
    };

    await sql`
      UPDATE system_announcements 
      SET status = 'sent', sent_at = NOW(), stats = ${JSON.stringify(stats)}
      WHERE id = ${Number(announcementId)}
    `;

    return { success: true, stats };
  } catch (error) {
    console.error("Error sending announcement:", error);
    return { success: false, error: String(error) };
  }
}

export async function getActiveAnnouncements(userId: string): Promise<Announcement[]> {
  try {
    const results = await sql`
      SELECT id, title, message, priority, target_audience as target, 
             delivery_channels as "deliveryChannels", status, 
             scheduled_at as "scheduledAt", sent_at as "sentAt", 
             expires_at as "expiresAt", created_by as "createdBy", 
             stats, created_at as "createdAt"
      FROM system_announcements 
      WHERE status = 'sent' 
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY sent_at DESC LIMIT 5
    `;
    return results as unknown as Announcement[];
  } catch (error) {
    console.error("Error fetching active announcements:", error);
    return [];
  }
}

export async function deleteAnnouncement(id: string): Promise<boolean> {
  try {
    const result = await sql`
      DELETE FROM system_announcements WHERE id = ${Number(id)}
    `;
    return result.count > 0;
  } catch (error) {
    console.error("Error deleting announcement:", error);
    return false;
  }
}
