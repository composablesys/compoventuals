names=("treedocLww" "textCrdt" "mapLww" "rgaLww" "rga")
for measurement in "time" "network" "memory" "save"
do
  for name in ${names[*]}
  do
    npm start -- $1 $2 $3 $4 "automerge_perf" $name $measurement "whole"
  done
done

names=("LwwMap" "LwwMapRolling" "Register" "TextLtr" "TextRandom")
for measurement in "time" "network" "memory" "save"
do
  for name in ${names[*]}
  do
    npm start -- $1 $2 $3 $4 "micro_crdts" $name $measurement "whole"
  done
done

names=("compoCrdt" "compoJsonText" "compoJsonCrdt" "compoMovableCrdt" "compoCrdtRga" "compoMovableCrdtRga")
for measurement in "time" "network" "memory" "save"
do
  for name in ${names[*]}
  do
    npm start -- $1 $2 $3 $4 "todo_list" $name $measurement "whole"
  done
done