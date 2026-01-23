import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";

export interface Notification {
  _id?: ObjectId;
  userId: string;
  shopId?: number;
  type: "ticket_created" | "ticket_updated" | "ticket_message" | "ticket_resolved" | "system";
  title: string;
  message: string;
  link?: string;
  read: boolean;
  createdAt: Date;
  metadata?: Record<string, any>;
}

export async function createNotification(notification: Omit<Notification, "_id" | "read" | "createdAt">): Promise<ObjectId | null> {
  try {
    const db = await getDb();
    const result = await db.collection("notifications").insertOne({
      ...notification,
      read: false,
      createdAt: new Date(),
    });
    return result.insertedId;
  } catch (error) {
    console.error("Error creating notification:", error);
    return null;
  }
}

export async function createNotificationsForUsers(
  userIds: string[],
  notification: Omit<Notification, "_id" | "userId" | "read" | "createdAt">
): Promise<number> {
  try {
    const db = await getDb();
    const docs = userIds.map(userId => ({
      ...notification,
      userId,
      read: false,
      createdAt: new Date(),
    }));
    
    if (docs.length === 0) return 0;
    
    const result = await db.collection("notifications").insertMany(docs);
    return result.insertedCount;
  } catch (error) {
    console.error("Error creating notifications:", error);
    return 0;
  }
}

export async function getUserNotifications(
  userId: string,
  limit: number = 20,
  unreadOnly: boolean = false
): Promise<Notification[]> {
  try {
    const db = await getDb();
    const query: any = { userId };
    if (unreadOnly) {
      query.read = false;
    }
    
    return await db.collection("notifications")
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray() as Notification[];
  } catch (error) {
    console.error("Error fetching notifications:", error);
    return [];
  }
}

export async function getUnreadCount(userId: string): Promise<number> {
  try {
    const db = await getDb();
    return await db.collection("notifications").countDocuments({
      userId,
      read: false,
    });
  } catch (error) {
    console.error("Error counting notifications:", error);
    return 0;
  }
}

export async function markAsRead(notificationId: string, userId: string): Promise<boolean> {
  try {
    const db = await getDb();
    const result = await db.collection("notifications").updateOne(
      { _id: new ObjectId(notificationId), userId },
      { $set: { read: true } }
    );
    return result.modifiedCount > 0;
  } catch (error) {
    console.error("Error marking notification as read:", error);
    return false;
  }
}

export async function markAllAsRead(userId: string): Promise<number> {
  try {
    const db = await getDb();
    const result = await db.collection("notifications").updateMany(
      { userId, read: false },
      { $set: { read: true } }
    );
    return result.modifiedCount;
  } catch (error) {
    console.error("Error marking all notifications as read:", error);
    return 0;
  }
}

export async function deleteNotification(notificationId: string, userId: string): Promise<boolean> {
  try {
    const db = await getDb();
    const result = await db.collection("notifications").deleteOne({
      _id: new ObjectId(notificationId),
      userId,
    });
    return result.deletedCount > 0;
  } catch (error) {
    console.error("Error deleting notification:", error);
    return false;
  }
}

export async function getPlatformAdminNotifications(limit: number = 20): Promise<Notification[]> {
  try {
    const db = await getDb();
    return await db.collection("notifications")
      .find({ userId: { $regex: /^admin:/ } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray() as Notification[];
  } catch (error) {
    console.error("Error fetching admin notifications:", error);
    return [];
  }
}

export async function getAdminUnreadCount(): Promise<number> {
  try {
    const db = await getDb();
    return await db.collection("notifications").countDocuments({
      userId: { $regex: /^admin:/ },
      read: false,
    });
  } catch (error) {
    console.error("Error counting admin notifications:", error);
    return 0;
  }
}

export async function clearTicketNotifications(ticketId: string): Promise<number> {
  try {
    const db = await getDb();
    const result = await db.collection("notifications").updateMany(
      { 
        "metadata.ticketId": ticketId,
        read: false
      },
      { $set: { read: true } }
    );
    return result.modifiedCount;
  } catch (error) {
    console.error("Error clearing ticket notifications:", error);
    return 0;
  }
}
