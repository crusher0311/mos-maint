import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";
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
  _id?: ObjectId;
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
  announcement: Omit<Announcement, "_id" | "createdAt" | "stats">
): Promise<ObjectId | null> {
  try {
    const db = await getDb();
    const result = await db.collection("system_announcements").insertOne({
      ...announcement,
      createdAt: new Date(),
      stats: { totalRecipients: 0, emailsSent: 0, inAppSent: 0 },
    });
    return result.insertedId;
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
    const db = await getDb();
    const query: Record<string, unknown> = {};
    if (status) query.status = status;

    return (await db
      .collection("system_announcements")
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()) as Announcement[];
  } catch (error) {
    console.error("Error fetching announcements:", error);
    return [];
  }
}

export async function getAnnouncementById(id: string): Promise<Announcement | null> {
  try {
    const db = await getDb();
    return (await db
      .collection("system_announcements")
      .findOne({ _id: new ObjectId(id) })) as Announcement | null;
  } catch (error) {
    console.error("Error fetching announcement:", error);
    return null;
  }
}

export async function getTargetedUsers(target: AnnouncementTarget): Promise<AnnouncementRecipient[]> {
  try {
    const db = await getDb();
    const recipients: AnnouncementRecipient[] = [];

    if (target.type === "all") {
      const users = await db
        .collection("users")
        .find({ email: { $exists: true } })
        .project({ email: 1, shopId: 1 })
        .toArray();

      for (const user of users) {
        recipients.push({
          email: user.email,
          userId: user._id.toString(),
          shopId: user.shopId,
        });
      }
    } else if (target.type === "shops" && target.shopIds?.length) {
      const users = await db
        .collection("users")
        .find({
          shopId: { $in: target.shopIds },
          email: { $exists: true },
        })
        .project({ email: 1, shopId: 1 })
        .toArray();

      for (const user of users) {
        recipients.push({
          email: user.email,
          userId: user._id.toString(),
          shopId: user.shopId,
        });
      }
    } else if (target.type === "roles" && target.roles?.length) {
      const users = await db
        .collection("users")
        .find({
          role: { $in: target.roles },
          email: { $exists: true },
        })
        .project({ email: 1, shopId: 1, role: 1 })
        .toArray();

      for (const user of users) {
        recipients.push({
          email: user.email,
          userId: user._id.toString(),
          shopId: user.shopId,
        });
      }
    } else if (target.type === "sms_integration" && target.smsIntegrations?.length) {
      const integrationQueries = target.smsIntegrations.map((sms) => {
        if (sms === "tekmetric") {
          return { "integrations.tekmetric.shopId": { $exists: true } };
        } else if (sms === "protractor") {
          return {
            $or: [
              { "integrations.protractor.apiKey": { $exists: true } },
              { protractorApiKey: { $exists: true } },
            ],
          };
        } else if (sms === "autoflow") {
          return { "integrations.autoflow.webhookToken": { $exists: true } };
        }
        return {};
      });

      const shops = await db
        .collection("shops")
        .find({ $or: integrationQueries })
        .project({ shopId: 1, name: 1 })
        .toArray();

      const shopIds = shops.map((s) => s.shopId);
      const shopNameMap = new Map(shops.map((s) => [s.shopId, s.name]));

      if (shopIds.length > 0) {
        const users = await db
          .collection("users")
          .find({
            shopId: { $in: shopIds },
            email: { $exists: true },
          })
          .project({ email: 1, shopId: 1 })
          .toArray();

        for (const user of users) {
          recipients.push({
            email: user.email,
            userId: user._id.toString(),
            shopId: user.shopId,
            shopName: shopNameMap.get(user.shopId),
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
    const db = await getDb();
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

    await db.collection("system_announcements").updateOne(
      { _id: new ObjectId(announcementId) },
      {
        $set: {
          status: "sent",
          sentAt: new Date(),
          stats,
        },
      }
    );

    return { success: true, stats };
  } catch (error) {
    console.error("Error sending announcement:", error);
    return { success: false, error: String(error) };
  }
}

export async function getActiveAnnouncements(userId: string): Promise<Announcement[]> {
  try {
    const db = await getDb();
    const now = new Date();

    return (await db
      .collection("system_announcements")
      .find({
        status: "sent",
        priority: "critical",
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }],
      })
      .sort({ sentAt: -1 })
      .limit(5)
      .toArray()) as Announcement[];
  } catch (error) {
    console.error("Error fetching active announcements:", error);
    return [];
  }
}

export async function deleteAnnouncement(id: string): Promise<boolean> {
  try {
    const db = await getDb();
    const result = await db
      .collection("system_announcements")
      .deleteOne({ _id: new ObjectId(id) });
    return result.deletedCount > 0;
  } catch (error) {
    console.error("Error deleting announcement:", error);
    return false;
  }
}
