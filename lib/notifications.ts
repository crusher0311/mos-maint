import sql from "@/lib/db/postgres";

export interface Notification {
  id?: number;
  userId: string;
  shopId?: number;
  type: "ticket_created" | "ticket_updated" | "ticket_message" | "ticket_resolved" | "system";
  title: string;
  message: string;
  link?: string;
  isRead: boolean;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export async function createNotification(notification: Omit<Notification, "id" | "isRead" | "createdAt">): Promise<number | null> {
  try {
    const result = await sql`
      INSERT INTO notifications (user_id, shop_id, type, title, message, link, metadata)
      VALUES (
        ${notification.userId}::uuid, 
        ${notification.shopId ? String(notification.shopId) : null}, 
        ${notification.type}, 
        ${notification.title}, 
        ${notification.message || null}, 
        ${notification.link || null}, 
        ${JSON.stringify(notification.metadata || {})}
      )
      RETURNING id
    `;
    return result[0]?.id || null;
  } catch (error) {
    console.error("Error creating notification:", error);
    return null;
  }
}

export async function createNotificationsForUsers(
  userIds: string[],
  notification: Omit<Notification, "id" | "userId" | "isRead" | "createdAt">
): Promise<number> {
  try {
    if (userIds.length === 0) return 0;
    
    const values = userIds.map(userId => ({
      user_id: userId,
      shop_id: notification.shopId ? String(notification.shopId) : null,
      type: notification.type,
      title: notification.title,
      message: notification.message || null,
      link: notification.link || null,
      metadata: JSON.stringify(notification.metadata || {}),
    }));
    
    const result = await sql`
      INSERT INTO notifications ${sql(values)}
    `;
    return result.count;
  } catch (error) {
    console.error("Error creating notifications:", error);
    return 0;
  }
}

export async function getUserNotifications(
  userIdOrEmail: string,
  limit: number = 20,
  unreadOnly: boolean = false
): Promise<Notification[]> {
  try {
    const userId = await resolveUserId(userIdOrEmail);
    if (!userId) return [];
    
    let query;
    if (unreadOnly) {
      query = sql`
        SELECT id, user_id as "userId", shop_id as "shopId", type, title, message, 
               link, is_read as "isRead", metadata, created_at as "createdAt"
        FROM notifications 
        WHERE user_id = ${userId} AND is_read = FALSE
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    } else {
      query = sql`
        SELECT id, user_id as "userId", shop_id as "shopId", type, title, message, 
               link, is_read as "isRead", metadata, created_at as "createdAt"
        FROM notifications 
        WHERE user_id = ${userId}
        ORDER BY created_at DESC LIMIT ${limit}
      `;
    }
    
    const results = await query;
    return results as unknown as Notification[];
  } catch (error) {
    console.error("Error fetching notifications:", error);
    return [];
  }
}

async function resolveUserId(userIdOrEmail: string): Promise<string | null> {
  if (userIdOrEmail.includes('@')) {
    const users = await sql`SELECT id FROM users WHERE email = ${userIdOrEmail} LIMIT 1`;
    return users[0]?.id as string || null;
  }
  return userIdOrEmail;
}

export async function getUnreadCount(userIdOrEmail: string): Promise<number> {
  try {
    const userId = await resolveUserId(userIdOrEmail);
    if (!userId) return 0;
    
    const result = await sql`
      SELECT COUNT(*) as count FROM notifications 
      WHERE user_id = ${userId}::uuid AND is_read = FALSE
    `;
    return Number(result[0]?.count || 0);
  } catch (error) {
    console.error("Error counting notifications:", error);
    return 0;
  }
}

export async function markAsRead(notificationId: string, userIdOrEmail: string): Promise<boolean> {
  try {
    const userId = await resolveUserId(userIdOrEmail);
    if (!userId) return false;
    
    const result = await sql`
      UPDATE notifications SET is_read = TRUE 
      WHERE id = ${Number(notificationId)} AND user_id = ${userId}::uuid
    `;
    return result.count > 0;
  } catch (error) {
    console.error("Error marking notification as read:", error);
    return false;
  }
}

export async function markAllAsRead(userIdOrEmail: string): Promise<number> {
  try {
    const userId = await resolveUserId(userIdOrEmail);
    if (!userId) return 0;
    
    const result = await sql`
      UPDATE notifications SET is_read = TRUE 
      WHERE user_id = ${userId}::uuid AND is_read = FALSE
    `;
    return result.count;
  } catch (error) {
    console.error("Error marking all notifications as read:", error);
    return 0;
  }
}

export async function deleteNotification(notificationId: string, userIdOrEmail: string): Promise<boolean> {
  try {
    const userId = await resolveUserId(userIdOrEmail);
    if (!userId) return false;
    
    const result = await sql`
      DELETE FROM notifications 
      WHERE id = ${Number(notificationId)} AND user_id = ${userId}::uuid
    `;
    return result.count > 0;
  } catch (error) {
    console.error("Error deleting notification:", error);
    return false;
  }
}

export async function getPlatformAdminNotifications(limit: number = 20): Promise<Notification[]> {
  try {
    const results = await sql`
      SELECT n.id, n.user_id as "userId", n.shop_id as "shopId", n.type, n.title, 
             n.message, n.link, n.is_read as "isRead", n.metadata, n.created_at as "createdAt"
      FROM notifications n
      JOIN users u ON n.user_id = u.id
      WHERE u.is_super_admin = TRUE
      ORDER BY n.created_at DESC LIMIT ${limit}
    `;
    return results as unknown as Notification[];
  } catch (error) {
    console.error("Error fetching admin notifications:", error);
    return [];
  }
}

export async function getAdminUnreadCount(): Promise<number> {
  try {
    const result = await sql`
      SELECT COUNT(*) as count FROM notifications n
      JOIN users u ON n.user_id = u.id
      WHERE u.is_super_admin = TRUE AND n.is_read = FALSE
    `;
    return Number(result[0]?.count || 0);
  } catch (error) {
    console.error("Error counting admin notifications:", error);
    return 0;
  }
}

export async function clearTicketNotifications(ticketId: string): Promise<number> {
  try {
    const result = await sql`
      UPDATE notifications SET is_read = TRUE 
      WHERE metadata->>'ticketId' = ${ticketId} AND is_read = FALSE
    `;
    return result.count;
  } catch (error) {
    console.error("Error clearing ticket notifications:", error);
    return 0;
  }
}
