document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get(['kickLootState'], (result) => {
        const state = result.kickLootState;
        const content = document.getElementById('content');
        
        content.textContent = '';
        
        if (!state) {
            content.textContent = 'Open Kick.com and log in to initialize.';
            return;
        }
        
        if (state.status === 'claimed') {
            const titleDiv = document.createElement('div');
            titleDiv.style.fontSize = '16px';
            titleDiv.style.fontWeight = 'bold';
            titleDiv.className = 'accent';
            titleDiv.textContent = 'Reward Claimed Today!';
            content.appendChild(titleDiv);

            if (state.rewardInfo && state.rewardInfo.image) {
                const imgContainer = document.createElement('div');
                imgContainer.className = 'img-container';
                const img = document.createElement('img');
                img.src = state.rewardInfo.image;
                img.alt = 'Reward Image';
                imgContainer.appendChild(img);
                content.appendChild(imgContainer);
            }

            if (state.rewardInfo && state.rewardInfo.rarity) {
                const rarityDiv = document.createElement('div');
                rarityDiv.className = 'rarity';
                rarityDiv.textContent = state.rewardInfo.rarity;
                content.appendChild(rarityDiv);
            }
        } else if (state.status === 'progress') {
            const wrapper = document.createElement('div');
            wrapper.appendChild(document.createTextNode('Watch for'));
            wrapper.appendChild(document.createElement('br'));
            
            const numSpan = document.createElement('span');
            numSpan.className = 'big-number';
            numSpan.textContent = state.val;
            wrapper.appendChild(numSpan);
            
            wrapper.appendChild(document.createElement('br'));
            wrapper.appendChild(document.createTextNode(' more minutes to claim.'));
            content.appendChild(wrapper);
        } else if (state.status === 'ready') {
            const readyDiv = document.createElement('div');
            readyDiv.className = 'accent';
            readyDiv.style.fontSize = '16px';
            readyDiv.style.fontWeight = 'bold';
            readyDiv.textContent = 'Reward Ready!';
            content.appendChild(readyDiv);
            
            content.appendChild(document.createElement('br'));
            content.appendChild(document.createTextNode('Claiming shortly...'));
        } else if (state.status === 'error') {
            const errDiv = document.createElement('div');
            errDiv.style.color = '#FF0000';
            errDiv.textContent = 'Error communicating with Kick API.';
            content.appendChild(errDiv);
        } else {
            const defaultDiv = document.createElement('div');
            defaultDiv.textContent = state.tooltip || 'Checking status...';
            content.appendChild(defaultDiv);
        }
    });
});