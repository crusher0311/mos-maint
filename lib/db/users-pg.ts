import sql from "@/lib/db/postgres";

export interface User {
  id: string;
  email: string;
  password_hash: string | null;
  name: string | null;
  user_type: string | null;
  environment: string | null;
  role: string | null;
  is_super_admin: boolean;
  is_active: boolean;
  shop_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  preferences: Record<string, unknown> | null;
  last_login_at: Date | null;
}

export async function getUserById(userId: string): Promise<User | null> {
  const users = await sql<User[]>`
    SELECT * FROM users WHERE id = ${userId} LIMIT 1
  `;
  return users[0] || null;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const normalizedEmail = email.toLowerCase().trim();
  const users = await sql<User[]>`
    SELECT * FROM users WHERE LOWER(email) = ${normalizedEmail} LIMIT 1
  `;
  return users[0] || null;
}

export async function getUsersByShopId(shopId: string): Promise<User[]> {
  return sql<User[]>`
    SELECT * FROM users WHERE shop_id = ${shopId} ORDER BY name, email
  `;
}

export async function createUser(data: {
  email: string;
  passwordHash?: string | null;
  name?: string | null;
  userType?: string | null;
  environment?: string | null;
  role?: string | null;
  isSuperAdmin?: boolean;
  isActive?: boolean;
  shopId?: string | null;
  metadata?: Record<string, unknown> | null;
  preferences?: Record<string, unknown> | null;
}): Promise<User> {
  const now = new Date();
  const normalizedEmail = data.email.toLowerCase().trim();
  
  const users = await sql<User[]>`
    INSERT INTO users (
      id, email, password_hash, name, user_type, environment, role,
      is_super_admin, is_active, shop_id, metadata, preferences,
      created_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      ${normalizedEmail},
      ${data.passwordHash || null},
      ${data.name || null},
      ${data.userType || null},
      ${data.environment || null},
      ${data.role || null},
      ${data.isSuperAdmin || false},
      ${data.isActive !== false},
      ${data.shopId || null},
      ${data.metadata ? JSON.stringify(data.metadata) : null}::jsonb,
      ${data.preferences ? JSON.stringify(data.preferences) : null}::jsonb,
      ${now},
      ${now}
    )
    RETURNING *
  `;
  
  return users[0];
}

export async function updateUser(
  userId: string,
  updates: Partial<Omit<User, 'id' | 'email' | 'created_at'>>
): Promise<User | null> {
  const passwordHash = updates.password_hash ?? null;
  const name = updates.name ?? null;
  const userType = updates.user_type ?? null;
  const environment = updates.environment ?? null;
  const role = updates.role ?? null;
  const isSuperAdmin = updates.is_super_admin ?? null;
  const isActive = updates.is_active ?? null;
  const shopId = updates.shop_id ?? null;
  const metadata = updates.metadata ? JSON.stringify(updates.metadata) : null;
  const preferences = updates.preferences ? JSON.stringify(updates.preferences) : null;
  const lastLoginAt = updates.last_login_at ?? null;

  const users = await sql<User[]>`
    UPDATE users
    SET 
      password_hash = COALESCE(${passwordHash}, password_hash),
      name = COALESCE(${name}, name),
      user_type = COALESCE(${userType}, user_type),
      environment = COALESCE(${environment}, environment),
      role = COALESCE(${role}, role),
      is_super_admin = COALESCE(${isSuperAdmin}, is_super_admin),
      is_active = COALESCE(${isActive}, is_active),
      shop_id = COALESCE(${shopId}, shop_id),
      metadata = COALESCE(${metadata}::jsonb, metadata),
      preferences = COALESCE(${preferences}::jsonb, preferences),
      last_login_at = COALESCE(${lastLoginAt}, last_login_at),
      updated_at = NOW()
    WHERE id = ${userId}
    RETURNING *
  `;
  
  return users[0] || null;
}

export async function updateLastLogin(userId: string): Promise<void> {
  await sql`
    UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = ${userId}
  `;
}

export async function deleteUser(userId: string): Promise<void> {
  await sql`DELETE FROM users WHERE id = ${userId}`;
}

export async function getSuperAdmins(): Promise<User[]> {
  return sql<User[]>`
    SELECT * FROM users WHERE is_super_admin = true AND is_active = true ORDER BY name, email
  `;
}
