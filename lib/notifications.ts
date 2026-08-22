import { ObjectId } from "mongodb";
import * as repo from "@/lib/data/repositories/notifications";

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
  metadata?: Record<string, unknown>;
}

export const PLATFORM_ADMIN_INBOX_USER_ID = repo.PLATFORM_ADMIN_INBOX_USER_ID;

export async function createNotification(
  notification: Omit<Notification, "_id" | "read" | "createdAt">,
): Promise<ObjectId | null> {
  try {
    return await repo.insertNotification({
      ...notification,
      read: false,
      createdAt: new Date(),
    });
  } catch (error) {
    console.error("Error creating notification:", error);
    return null;
  }
}

export async function createNotificationsForUsers(
  userIds: string[],
  notification: Omit<Notification, "_id" | "userId" | "read" | "createdAt">,
): Promise<number> {
  try {
    if (userIds.length === 0) return 0;
    const docs = userIds.map((userId) => ({
      ...notification,
      userId,
      read: false,
      createdAt: new Date(),
    }));
    return await repo.insertNotifications(docs);
  } catch (error) {
    console.error("Error creating notifications:", error);
    return 0;
  }
}

export async function getUserNotifications(
  userId: string,
  limit: number = 20,
  unreadOnly: boolean = false,
): Promise<Notification[]> {
  try {
    return (await repo.findForUser(userId, { limit, unreadOnly })) as Notification[];
  } catch (error) {
    console.error("Error fetching notifications:", error);
    return [];
  }
}

export async function getUnreadCount(userId: string): Promise<number> {
  try {
    return await repo.countUnreadForUser(userId);
  } catch (error) {
    console.error("Error counting notifications:", error);
    return 0;
  }
}

export async function markAsRead(notificationId: string, userId: string): Promise<boolean> {
  try {
    return await repo.markOneRead(notificationId, userId);
  } catch (error) {
    console.error("Error marking notification as read:", error);
    return false;
  }
}

export async function markAllAsRead(userId: string): Promise<number> {
  try {
    return await repo.markAllReadForUser(userId);
  } catch (error) {
    console.error("Error marking all notifications as read:", error);
    return 0;
  }
}

export async function deleteNotification(notificationId: string, userId: string): Promise<boolean> {
  try {
    return await repo.deleteOneForUser(notificationId, userId);
  } catch (error) {
    console.error("Error deleting notification:", error);
    return false;
  }
}

export async function getPlatformAdminNotifications(limit: number = 20): Promise<Notification[]> {
  try {
    return (await repo.findForAdmins(limit)) as Notification[];
  } catch (error) {
    console.error("Error fetching admin notifications:", error);
    return [];
  }
}

export async function createPlatformAdminNotification(
  notification: Omit<Notification, "_id" | "userId" | "read" | "createdAt"> & { logicalId: string },
): Promise<ObjectId | null> {
  try {
    const { logicalId, ...doc } = notification;
    return await repo.upsertPlatformAdminNotification({
      ...doc,
      platformAdminNotificationKey: logicalId,
    }) as ObjectId;
  } catch (error) {
    console.error("Error creating shared admin notification:", error);
    return null;
  }
}

export async function getPlatformAdminUnreadNotifications(limit = 20): Promise<Notification[]> {
  try {
    return (await repo.findForAdmins(limit, true)) as Notification[];
  } catch (error) {
    console.error("Error fetching unread admin notifications:", error);
    return [];
  }
}

export async function markPlatformAdminNotificationRead(notificationId: string): Promise<boolean> {
  try {
    return await repo.markOneAdminNotificationRead(notificationId);
  } catch (error) {
    console.error("Error marking shared admin notification as read:", error);
    return false;
  }
}

export async function markAllPlatformAdminNotificationsRead(): Promise<number> {
  try {
    return await repo.markAllAdminNotificationsRead();
  } catch (error) {
    console.error("Error marking shared admin notifications as read:", error);
    return 0;
  }
}

export async function deletePlatformAdminNotification(notificationId: string): Promise<boolean> {
  try {
    return await repo.deleteOneAdminNotification(notificationId);
  } catch (error) {
    console.error("Error deleting shared admin notification:", error);
    return false;
  }
}

export async function getAdminUnreadCount(): Promise<number> {
  try {
    return await repo.countUnreadForAdmins();
  } catch (error) {
    console.error("Error counting admin notifications:", error);
    return 0;
  }
}

export async function clearTicketNotifications(ticketId: string): Promise<number> {
  try {
    return await repo.markAllReadForTicket(ticketId);
  } catch (error) {
    console.error("Error clearing ticket notifications:", error);
    return 0;
  }
}
