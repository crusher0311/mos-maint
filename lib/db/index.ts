export * from './customers-pg';
export * from './vehicles-pg';
export * from './work-orders-pg';
export { default as sql } from './postgres';

export { 
  getShopById, 
  getShopBySlug, 
  updateShop,
  type Shop 
} from '../shops';
