import summary from './burnett-summary.json';
import type { ShopState } from './model';

/** A narrated presentation, NOT a reconstruction of a real day or staffing roster. */
export function burnettPresentation(seed: ShopState): ShopState {
  const staff = [
    ['Dakota Campbell', 'Diagnostic work'],
    ['Jaiden Weixelman', 'Brake service'],
    ['Ethan Engelhorn', 'Tire & maintenance'],
    ['Jason Roby', 'Alignment & chassis'],
    ['Jeffery Sims', 'Maintenance'],
    ['Daniel Brownlee', 'Tire & maintenance'],
  ];
  const packages: Record<string,string> = {
    j1:'Suspension/Steering Testing and Replacement',
    j2:'Suspension Control Arm, Lower', j3:'All Wheel Alignment',
    j5:'Full Service Oil Change', j6:'Brake Inspection',
    j7:'Front Disc Brake Service', j9:'Complete Electrical System Check',
    j10:'Starter Motor', j11:'•Oil Change - Full Synthetic',
    j12:'Tire Rotation - Full Service Oil Change',
    j13:'Suspension/Steering Testing and Replacement',
    j14:'All Wheel Alignment', j15:'Cooling System Performance Test',
    j16:'Water Pump', j17:'Basic Electrical System Check',
    j18:'Battery Installation with Purchase',
    j19:'Suspension/Steering Testing and Replacement',
    j20:'Strut Assembly, Front', j21:'All Wheel Alignment',
    j22:'Basic Vehicle Inspection - No Fluid Service',
    j23:'Mount, Install & Balance - 4 Tires',
    j24:'Driveability Testing Labor (S700)', j25:'Spark Plug(s)',
  };
  const assignments: Record<string,string> = {
    j6:'t2',j7:'t2',j8:'t2',j10:'t1',j12:'t3',j13:'t4',
    j15:'t1',j16:'t1',j17:'t2',j18:'t2',j19:'t4',j20:'t4',j23:'t3',
  };
  return {
    ...seed,
    demoMode:'burnett',
    technicians:seed.technicians.map((tech,index)=>({...tech,name:staff[index][0],specialty:staff[index][1]})),
    vehicles:seed.vehicles.map((vehicle,index)=>({...vehicle,ro:`DEMO-${vehicle.ro}`,owner:`Demo customer ${String(index+1).padStart(2,'0')}`})),
    jobs:seed.jobs.map(job=>{
      const sourcePackage=packages[job.id];
      if (sourcePackage && !summary.catalog.some(p=>p.name===sourcePackage)) {
        throw new Error(`Presentation package not found in reviewed CSV catalog: ${sourcePackage}`);
      }
      return {...job,techId:assignments[job.id] ?? job.techId,sourcePackage,
        title:job.id==='j23'?'Mount & balance tires':job.title};
    }),
  };
}
