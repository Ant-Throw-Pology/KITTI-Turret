// Local emergency command to a running server; never creates a second GPIO owner.
const endpoint=process.env.TURRET_ESTOP_URL ?? 'http://127.0.0.1:8080/estop';
const response=await fetch(endpoint,{method:'POST'});
if(!response.ok)throw new Error(`E-stop request failed: ${response.status}`);
console.log('E-stop acknowledged');
