const button = document.getElementById('first_call');
const click = async() =>{
    const res = await fetch('https://us-central1-lar91xtracking.cloudfunctions.net/helloWorld');
    const text = await res.text();
    console.log(text);
}

button!.addEventListener('click',(e) => {
    click();
})
