*start|Input verification
[cm][nowait]First line[eval exp="Debug.message('flow=line')"][l]
[cm]Second line[eval exp="Debug.message('flow=page')"][p]
[cm][link target=*choice]Choose[endlink][eval exp="Debug.message('flow=link')"][s]
*choice|Choice
[cm]Selected[eval exp="Debug.message('flow=choice')"][s]
