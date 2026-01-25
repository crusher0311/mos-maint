import { ensureIndexes, indexes } from '../lib/db-indexes';

async function main() {
  console.log('Initializing MongoDB indexes...');
  console.log(`Total index definitions: ${indexes.length}`);
  
  try {
    const result = await ensureIndexes();
    
    console.log('\nIndex Creation Results:');
    console.log('=======================');
    console.log(`Created: ${result.created}`);
    console.log(`Existing: ${result.existing}`);
    
    if (result.errors.length > 0) {
      console.log('\nErrors:');
      result.errors.forEach(err => console.log(`  - ${err}`));
    }
    
    console.log('\nDone!');
    process.exit(result.errors.length > 0 ? 1 : 0);
  } catch (error) {
    console.error('Failed to initialize indexes:', error);
    process.exit(1);
  }
}

main();
